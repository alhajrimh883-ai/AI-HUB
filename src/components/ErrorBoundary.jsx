/**
 * ErrorBoundary — Catches render-time exceptions from a subtree so a bug in
 * one page doesn't blank the whole app. React's default behaviour with
 * uncaught render errors is to unmount the entire tree, which presents as a
 * mysterious blank window. This boundary turns that into a visible panel the
 * user can act on (reload or switch tabs).
 *
 * We deliberately keep it dumb: no error reporting, no retry counter, just a
 * readable fallback with the error message and stack so the next bug is
 * easier to diagnose.
 */

import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info });
    // Surface to the dev console as well so the user sees it in DevTools if open.
    console.error('[ErrorBoundary]', this.props.label || 'unknown', error, info);
  }

  render() {
    if (this.state.error) {
      const msg = this.state.error?.message || String(this.state.error);
      const stack = this.state.error?.stack || this.state.info?.componentStack || '';
      return (
        <div className="p-6 m-6 border border-red-500/40 bg-red-500/10 rounded max-w-3xl">
          <h2 className="text-red-300 text-sm font-bold mb-2">
            {this.props.label || 'Component'} crashed
          </h2>
          <p className="text-red-200 text-xs mb-3">{msg}</p>
          <pre className="text-[10px] text-neutral-400 whitespace-pre-wrap max-h-64 overflow-auto bg-black/40 p-2 rounded">
            {stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null, info: null })}
            className="mt-3 btn btn-accent text-[11px] px-3 py-1">
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
