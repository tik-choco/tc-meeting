import { render } from "preact";
import { App } from './app';
import { writeAppManifest } from './lib/appManifest';
import "./index.css";

writeAppManifest({ app: 'tc-meeting', publishes: [], consumes: [], reads: [] });
render(<App />, document.getElementById("app")!);
