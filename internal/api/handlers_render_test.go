//go:build !nod2

package api

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderD2(t *testing.T) {
	s, root := buildTestServerWithRoot(t)
	get := func(source, theme string, header ...string) *httptest.ResponseRecorder {
		q := url.Values{"source": {source}, "theme": {theme}}
		req := httptest.NewRequest(http.MethodGet, "/api/kiwi/render/d2?"+q.Encode(), nil)
		for i := 0; i+1 < len(header); i += 2 {
			req.Header.Set(header[i], header[i+1])
		}
		rec := httptest.NewRecorder()
		s.echo.ServeHTTP(rec, req)
		return rec
	}

	rec := get("api -> db: query", "")
	if rec.Code != http.StatusOK {
		t.Fatalf("GET: %d %s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/svg+xml" {
		t.Errorf("content type %q", ct)
	}
	if !strings.Contains(rec.Body.String(), "<svg") {
		t.Fatal("body is not an SVG")
	}
	etag := rec.Header().Get("ETag")
	if etag == "" {
		t.Fatal("missing ETag")
	}
	if got := get("api -> db: query", "", "If-None-Match", etag); got.Code != http.StatusNotModified {
		t.Errorf("conditional GET: want 304, got %d", got.Code)
	}
	if got := get("api -> db: query", "dark"); got.Header().Get("ETag") == etag {
		t.Error("dark render shares the light render's ETag")
	}

	cached, _ := filepath.Glob(filepath.Join(root, ".kiwi", "state", "d2", "*.svg"))
	if len(cached) == 0 {
		t.Error("render was not cached under .kiwi/state/d2")
	}
	bad := get("a -> {", "")
	if bad.Code != http.StatusUnprocessableEntity || !strings.Contains(bad.Body.String(), "missing destination") {
		t.Errorf("bad source: %d %s", bad.Code, bad.Body.String())
	}
	if empty := get("", ""); empty.Code != http.StatusBadRequest {
		t.Errorf("empty source: want 400, got %d", empty.Code)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/kiwi/render/d2", strings.NewReader(`{"source":"x -> y","theme":"dark"}`))
	req.Header.Set("Content-Type", "application/json")
	post := httptest.NewRecorder()
	s.echo.ServeHTTP(post, req)
	if post.Code != http.StatusOK || !strings.Contains(post.Body.String(), "<svg") {
		t.Errorf("POST: %d %.200s", post.Code, post.Body.String())
	}
}
