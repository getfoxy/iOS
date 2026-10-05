/* What build/foxy-app.js reads that it does not define, for its type check
 * (tests/types/tsconfig.app.json). Declarations only: nothing here ships or runs.
 * Kept apart from globals.d.ts, which is the wallet's.
 *
 * The app class is the body of a factory the page loader builds:
 * function (DCLogic, StreamableLogic, React) { ...build/foxy-app.js... }
 * so those three are declared here as globals. DCLogic is build/foxy-render.js's
 * base class, as that file defines it. */

declare class DCLogic {
  constructor(props?: any);
  props: any;
  state: any;
  __host: any;
  setState(update: any, callback?: () => void): void;
  forceUpdate(): void;
  componentDidMount(): void;
  componentDidUpdate(prevProps?: any, prevState?: any): void;
  componentWillUnmount(): void;
  renderVals(): any;
}
declare const StreamableLogic: typeof DCLogic;
declare const React: any;              // React 18.3.1, checked in tools/vendor

interface Window {
  FoxyWallet: any;                     // Web/foxy-wallet.js, type-checked in its own project
  FoxyGate: any;                       // Web/foxy-tor-gate.js
  FoxyProgress: any;                   // Web/foxy-send-progress.js
  FoxyReceiving: any;                  // Web/foxy-receive-progress.js
  FoxyMoving: any;                     // Web/foxy-move-progress.js
  webkit: any;                         // WKWebView's message handlers, present only in the app
  FOXY_DEBUG: any;                     // set by the native side at document start, in a debug build only
  __foxyGateChanged: () => void;       // the app sets it; the gate calls it when its warning changes
  __foxyPageHash: any;                 // set by the native side at document start: the hash of the page it staged
  __resources: any;                    // the page loader's map of unpacked assets
  webkitAudioContext: typeof AudioContext; // an older WebKit's name for AudioContext
}

interface Navigator {
  standalone?: boolean;                // iOS: true when opened from the home screen
}
