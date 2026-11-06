import { Component, type ReactNode } from "react";

/** One broken block must not blank the whole page: it is replaced by a short note. */
export class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(error);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p className="notice" role="status">
          Цей блок не вдалося показати.
        </p>
      );
    }
    return this.props.children;
  }
}
