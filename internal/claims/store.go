package claims

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

type Claim struct {
	Path      string    `json:"path"`
	ClaimedBy string    `json:"claimed_by"`
	ClaimedAt time.Time `json:"claimed_at"`
	ExpiresAt time.Time `json:"expires_at"`
}

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) (*Store, error) {
	s := &Store{db: db}
	if err := s.createSchema(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) createSchema() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS claims (
			path       TEXT PRIMARY KEY,
			claimed_by TEXT NOT NULL,
			claimed_at TEXT NOT NULL,
			expires_at TEXT NOT NULL
		);
		CREATE INDEX IF NOT EXISTS idx_claims_expires ON claims(expires_at);
	`)
	return err
}

func (s *Store) Claim(ctx context.Context, path, claimedBy string, leaseDuration time.Duration) (*Claim, error) {
	now := time.Now().UTC()
	expires := now.Add(leaseDuration)
	nowStr := now.Format(time.RFC3339)
	expiresStr := expires.Format(time.RFC3339)

	res, err := s.db.ExecContext(ctx, `
		INSERT INTO claims (path, claimed_by, claimed_at, expires_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(path) DO UPDATE SET
			claimed_by = excluded.claimed_by,
			claimed_at = excluded.claimed_at,
			expires_at = excluded.expires_at
		WHERE claims.expires_at < ? OR claims.claimed_by = ?
	`, path, claimedBy, nowStr, expiresStr, nowStr, claimedBy)
	if err != nil {
		return nil, fmt.Errorf("claim: %w", err)
	}

	n, _ := res.RowsAffected()
	if n == 0 {
		return nil, ErrAlreadyClaimed
	}

	return &Claim{
		Path:      path,
		ClaimedBy: claimedBy,
		ClaimedAt: now,
		ExpiresAt: expires,
	}, nil
}

func (s *Store) Release(ctx context.Context, path, claimedBy string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM claims WHERE path = ? AND claimed_by = ?`, path, claimedBy)
	if err != nil {
		return err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotHolder
	}
	return nil
}

func (s *Store) ActiveClaim(ctx context.Context, path string) (*Claim, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	var c Claim
	var claimedAt, expiresAt string
	err := s.db.QueryRowContext(ctx,
		`SELECT path, claimed_by, claimed_at, expires_at FROM claims WHERE path = ? AND expires_at >= ?`,
		path, now).Scan(&c.Path, &c.ClaimedBy, &claimedAt, &expiresAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	c.ClaimedAt, _ = time.Parse(time.RFC3339, claimedAt)
	c.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt)
	return &c, nil
}

func (s *Store) ExpireStale(ctx context.Context) (int, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	res, err := s.db.ExecContext(ctx, `DELETE FROM claims WHERE expires_at < ?`, now)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

func (s *Store) ListActive(ctx context.Context) ([]Claim, error) {
	now := time.Now().UTC().Format(time.RFC3339)
	rows, err := s.db.QueryContext(ctx,
		`SELECT path, claimed_by, claimed_at, expires_at FROM claims WHERE expires_at >= ? ORDER BY claimed_at`,
		now)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Claim
	for rows.Next() {
		var c Claim
		var claimedAt, expiresAt string
		if err := rows.Scan(&c.Path, &c.ClaimedBy, &claimedAt, &expiresAt); err != nil {
			return nil, err
		}
		c.ClaimedAt, _ = time.Parse(time.RFC3339, claimedAt)
		c.ExpiresAt, _ = time.Parse(time.RFC3339, expiresAt)
		out = append(out, c)
	}
	if out == nil {
		out = []Claim{}
	}
	return out, rows.Err()
}

// Rename moves claims along with the pages they cover, in one
// transaction. A path mapped to "" lost its page (merged away) and its claim
// is dropped. Expired rows at a destination are cleared first so a stale
// lease cannot block the move.
func (s *Store) Rename(ctx context.Context, renames map[string]string) error {
	if len(renames) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().UTC().Format(time.RFC3339)
	for from, to := range renames {
		if to == "" {
			if _, err := tx.ExecContext(ctx, `DELETE FROM claims WHERE path = ?`, from); err != nil {
				return fmt.Errorf("drop claim %s: %w", from, err)
			}
			continue
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM claims WHERE path = ? AND expires_at < ?`, to, now); err != nil {
			return fmt.Errorf("clear stale claim %s: %w", to, err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE OR IGNORE claims SET path = ? WHERE path = ?`, to, from); err != nil {
			return fmt.Errorf("move claim %s: %w", from, err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM claims WHERE path = ?`, from); err != nil {
			return fmt.Errorf("drop claim %s: %w", from, err)
		}
	}
	return tx.Commit()
}

func (s *Store) Close() error {
	return s.db.Close()
}

var (
	ErrAlreadyClaimed = fmt.Errorf("task already claimed by another agent")
	ErrNotHolder      = fmt.Errorf("not the current claim holder")
)
