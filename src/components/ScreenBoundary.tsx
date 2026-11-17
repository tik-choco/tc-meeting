import { Component } from 'preact';
import type { ComponentChildren } from 'preact';
import { ErrorNotice } from './ErrorNotice';
export class ScreenBoundary extends Component<{ children: ComponentChildren }, { error: unknown }> {
  state = { error: null as unknown };
  componentDidCatch(error: unknown) { this.setState({ error }); }
  render() { return this.state.error ? <div class="card"><ErrorNotice error={this.state.error} onDismiss={() => this.setState({ error: null })} /></div> : this.props.children; }
}
