import { Component, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  fallback?: ReactNode | ((error: Error) => ReactNode);
  /** A caught error is cleared when any of these change, e.g. the source being rendered. */
  resetKeys?: readonly unknown[];
};
type State = { error: Error | null };

function keysChanged(a: readonly unknown[] = [], b: readonly unknown[] = []): boolean {
  return a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };
  private caughtKeys: readonly unknown[] | undefined;

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch() {
    this.caughtKeys = this.props.resetKeys;
  }

  // Compared against the keys the error was caught under, not the previous
  // render's: an update that changes the keys and throws must stay caught.
  componentDidUpdate() {
    if (this.state.error && keysChanged(this.caughtKeys, this.props.resetKeys)) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (error) {
      const { fallback } = this.props;
      if (typeof fallback === "function") return fallback(error);
      return fallback ?? (
        <div className="p-6 rounded-lg border border-destructive/50 bg-destructive/5 text-sm">
          <p className="font-semibold text-destructive">Something went wrong rendering this content.</p>
          <pre className="mt-2 text-xs text-muted-foreground overflow-auto">
            {error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-3 text-xs underline text-primary"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
