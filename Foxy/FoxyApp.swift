//
//  FoxyApp.swift
//  Foxy
//
//  Created on 9/4/26.
//

import SwiftUI
import UIKit

@main
struct FoxyApp: App {
    /// The UIKit delegate, for what the SwiftUI lifecycle has no hook for.
    @UIApplicationDelegateAdaptor(FoxyAppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

/// No third-party keyboards anywhere in Foxy.
///
/// A keyboard extension is another developer's code that sees every key typed.
/// Given full access, it can send what it sees off the phone, and here that
/// means the twelve restore words, the PIN and ecash tokens. Refused, iOS uses
/// the system keyboard in every field, the web view's included.
final class FoxyAppDelegate: NSObject, UIApplicationDelegate {
    /// The earliest hook there is, so the file log's banner is the first line in
    /// the file and every print after it is captured. It records which launch
    /// arguments were set and whether a debugger is attached — a debugger stops
    /// iOS suspending the app, so a background or resume test run under one
    /// proves nothing, and the file says so rather than leaving a reader to
    /// wonder. DEBUG only: a Release build has no DebugLog at all.
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        #if DEBUG
        DebugLog.begin()
        #endif
        /* Last run's connection lines, ahead of this run's own, so a log handed
         * over after a force-quit describes the session that was killed and not
         * just the healthy one that replaced it. Read once and deleted. */
        FieldLog.takeLastRun()
        // and this run's banner after them, so the two runs are told apart
        FieldLog.begin()
        return true
    }

    func application(_ application: UIApplication,
                     shouldAllowExtensionPointIdentifier extensionPointIdentifier: UIApplication.ExtensionPointIdentifier) -> Bool {
        extensionPointIdentifier != .keyboard
    }
}
