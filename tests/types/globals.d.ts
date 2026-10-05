/* The globals foxy-wallet.js reads, for the type check (tests/types/tsconfig.json).
 * Declarations only: nothing here ships or runs. The libraries are typed as any,
 * because they are checked elsewhere (tools/vendor) and their shapes are theirs. */
interface Window {
  CashuTS: any;          // Web/cashu-ts.js
  qrcode: any;           // Web/qrcode.js
  FoxyWallet: any;       // this file's own export
  FoxyGate: any;         // Web/foxy-tor-gate.js
  webkit: any;           // WKWebView's message handlers, present only in the app
  __foxyUptime: any;     // set by the native side: seconds up and a process marker
  msCrypto: any;         // an old browser's name for crypto, never on iOS
}
declare var FoxyWallet: any;
