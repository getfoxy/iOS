import UIKit
import AVFoundation

// MARK: - live preview

/// A camera preview that lives inside a rectangle of the web UI and reads QR
/// codes continuously, without taking over the screen.
final class LiveScanner: NSObject, AVCaptureMetadataOutputObjectsDelegate {

    private let session = AVCaptureSession()
    private let container = UIView()
    private var preview: AVCaptureVideoPreviewLayer?
    private let onCode: (String) -> Void
    private var lastCode = ""
    private var lastAt = Date.distantPast
    private var configured = false
    /* One queue for starting and stopping, and what is wanted kept beside it.
     *
     * Both were thrown at the global queue, which promises no order, and each
     * decided what to do by reading `isRunning` on the main thread — which is
     * still true while a stop is waiting its turn and still false while a start
     * is. A pane shown in that window skipped its start and was then stopped
     * under itself: a camera pane on screen with nothing behind it. */
    private let work = DispatchQueue(label: "foxy.scanner.session")
    private var wanted = false
    /// Diary only: when the pane went up, and whether anything has been read since.
    private var shownAt = Date.distantPast
    private var sawAnything = false
    private var watching = false
    /// A token shown as an animated QR code (cashu.me) arrives a frame at a time;
    /// the page is handed the whole token, as if it had been one code.
    private let animated = AnimatedQRReader()
    private let progress = UILabel()
    /// The same number as a bar, because a percentage in small type at the
    /// bottom of the pane was not seen at all.
    private let bar = UIProgressView(progressViewStyle: .default)
    private let shade = UIView()

    init(onCode: @escaping (String) -> Void) {
        self.onCode = onCode
        super.init()
    }

    func attach(to host: UIView, above sibling: UIView) {
        container.backgroundColor = .black
        container.clipsToBounds = true
        container.isUserInteractionEnabled = false   // taps still reach the web UI
        container.isHidden = true
        shade.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        shade.layer.cornerRadius = 22
        shade.isHidden = true
        progress.textColor = .white
        progress.numberOfLines = 0
        progress.textAlignment = .center
        progress.backgroundColor = .clear
        bar.progressTintColor = UIColor(red: 0.95, green: 0.50, blue: 0.18, alpha: 1)
        bar.trackTintColor = UIColor.white.withAlphaComponent(0.28)
        bar.layer.cornerRadius = 5
        bar.clipsToBounds = true
        container.addSubview(shade)
        shade.addSubview(progress)
        shade.addSubview(bar)
        host.insertSubview(container, aboveSubview: sibling)
    }

    func show(in rect: CGRect) {
        container.frame = rect
        container.isHidden = false
        preview?.frame = container.bounds
        /* In the middle of the pane and a good part of it: the number large
         * enough to read at arm's length, the words under it, the bar under
         * those. */
        let w = min(rect.width - 40, 300), h: CGFloat = min(rect.height - 24, 190)
        shade.frame = CGRect(x: (rect.width - w) / 2, y: (rect.height - h) / 2, width: w, height: h)
        progress.frame = CGRect(x: 12, y: 10, width: w - 24, height: h - 44)
        bar.frame = CGRect(x: 22, y: h - 28, width: w - 44, height: 10)
        container.bringSubviewToFront(shade)
        animated.reset()
        shade.isHidden = true

        guard AVCaptureDevice.authorizationStatus(for: .video) != .denied else {
            print("[scan] the pane is up and camera access is off")
            return
        }
        if !configured { configure() }
        watch()
        shownAt = Date()
        sawAnything = false
        wanted = true
        print("[scan] pane up, \(Int(rect.width))x\(Int(rect.height))")
        work.async { [weak self] in
            guard let self = self, self.wanted else { return }
            if !self.session.isRunning {
                let began = Date()
                self.session.startRunning()
                print("[scan] camera \(self.session.isRunning ? "running" : "DID NOT START") after "
                      + "\(Int(Date().timeIntervalSince(began) * 1000))ms")
            } else {
                print("[scan] camera was already running")
            }
        }
    }

    /* What iOS says about the camera, written down. A scan that reads nothing
     * looks the same whether the code was bad, the lens was blurred, or the
     * phone had taken the camera away — and only the last is said out loud,
     * here (four scans in a row read nothing, after four that had). */
    private func watch() {
        guard !watching else { return }
        watching = true
        let nc = NotificationCenter.default
        nc.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: .main) { n in
            let e = n.userInfo?[AVCaptureSessionErrorKey] as? NSError
            print("[scan] camera error: \(e?.localizedDescription ?? "unknown") [\(e?.code ?? 0)]")
        }
        nc.addObserver(forName: .AVCaptureSessionWasInterrupted, object: session, queue: .main) { n in
            let raw = (n.userInfo?[AVCaptureSessionInterruptionReasonKey] as? NSNumber)?.intValue ?? 0
            let why: String
            switch AVCaptureSession.InterruptionReason(rawValue: raw) {
            case .videoDeviceNotAvailableInBackground: why = "Foxy is in the background"
            case .videoDeviceInUseByAnotherClient: why = "another app has the camera"
            case .videoDeviceNotAvailableWithMultipleForegroundApps: why = "split screen"
            case .videoDeviceNotAvailableDueToSystemPressure: why = "the phone is under pressure (heat or load)"
            case .audioDeviceInUseByAnotherClient: why = "audio in use"
            default: why = "reason \(raw)"
            }
            print("[scan] iOS took the camera away: \(why)")
        }
        nc.addObserver(forName: .AVCaptureSessionInterruptionEnded, object: session, queue: .main) { _ in
            print("[scan] iOS gave the camera back")
        }
    }

    func stop() {
        // Hidden rather than removed, deliberately: the container is built
        // once and re-shown on the next scan. Removing it here left nothing
        // to bring back and the second scan showed an empty frame.
        //
        // The audit's concern was a live capture session sitting behind later
        // screens. That is addressed by stopping the session below; the view
        // itself is inert while hidden.
        let wasUp = !container.isHidden
        container.isHidden = true
        animated.reset()
        shade.isHidden = true
        wanted = false
        if wasUp {
            print("[scan] pane down after \(Int(Date().timeIntervalSince(shownAt) * 1000))ms, "
                  + (sawAnything ? "having read a code" : "having read NOTHING"))
        }
        work.async { [weak self] in
            guard let self = self, !self.wanted else { return }
            if self.session.isRunning { self.session.stopRunning() }
        }
    }

    private func configure() {
        configured = true
        guard let device = ScanCamera.pick(),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else { print("[scan] no camera could be opened"); return }
        session.addInput(input)
        focusClose(device)
        /* As many pixels as the phone will give, as the full-screen scanner
         * takes (QRScannerViewController). That one was given a preset and a
         * close focus first and this one, which is the scanner the send
         * screen actually uses, was not. */
        for preset in [AVCaptureSession.Preset.hd4K3840x2160, .hd1920x1080] where session.canSetSessionPreset(preset) {
            session.sessionPreset = preset
            break
        }
        print("[scan] camera set up: \(session.sessionPreset.rawValue), \(device.deviceType.rawValue), "
              + "closest focus \(device.minimumFocusDistance)mm, zoom \(String(format: "%.2f", Double(device.videoZoomFactor)))")

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { print("[scan] the camera would not take a code reader"); return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = container.bounds
        /* Under everything else in the pane, not on top of it. Added last, it
         * sat over the progress shade: on the first scan after a launch — the
         * only one where the camera is set up after the pane is — an animated
         * code was read with no percentage showing at all. Every later scan put the shade back in front, which is
         * why it only happened sometimes. */
        container.layer.insertSublayer(layer, at: 0)
        preview = layer
    }

    /* Close focus, as the full-screen scanner does it and for its reasons: a
     * recent Pro cannot focus nearer than about 20cm, so it zooms until a code
     * of a realistic size fills enough of the frame from there. A phone that
     * focuses closer is left alone. */
    private func focusClose(_ device: AVCaptureDevice) {
        guard (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }
        if device.isFocusModeSupported(.continuousAutoFocus) { device.focusMode = .continuousAutoFocus }
        if device.isAutoFocusRangeRestrictionSupported { device.autoFocusRangeRestriction = .near }
        let closest = device.minimumFocusDistance
        guard closest > 0 else { return }
        let halfAngle = Float(device.activeFormat.videoFieldOfView) / 2 * .pi / 180
        guard halfAngle > 0 else { return }
        let wantedAt = (25 / Float(0.25)) / tan(halfAngle)
        guard wantedAt > 0 else { return }
        let zoom = CGFloat(Float(closest) / wantedAt)
        guard zoom > 1 else { return }
        device.videoZoomFactor = min(zoom, device.activeFormat.videoMaxZoomFactor)
    }

    /// The number, large, with what to do under it.
    private func say(percent: Int?, words: String) {
        let text = NSMutableAttributedString()
        let centred = NSMutableParagraphStyle()
        centred.alignment = .center
        centred.lineSpacing = 2
        if let percent {
            text.append(NSAttributedString(string: "\(percent)%\n", attributes: [
                .font: UIFont.systemFont(ofSize: 64, weight: .heavy),
                .foregroundColor: UIColor.white, .paragraphStyle: centred]))
            bar.setProgress(Float(percent) / 100, animated: true)
            bar.isHidden = false
        } else {
            bar.isHidden = true
        }
        text.append(NSAttributedString(string: words, attributes: [
            .font: UIFont.systemFont(ofSize: 16, weight: .bold),
            .foregroundColor: UIColor.white, .paragraphStyle: centred]))
        progress.attributedText = text
        shade.isHidden = false
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput objects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard let object = objects.first as? AVMetadataMachineReadableCodeObject,
              var text = object.stringValue, !text.isEmpty else { return }
        if !sawAnything {
            sawAnything = true
            // its length and nothing of what it says
            print("[scan] first code read \(Int(Date().timeIntervalSince(shownAt) * 1000))ms after the pane went up, "
                  + "\(text.count) chars")
        }
        switch animated.receive(text) {
        case .notAnimated:
            break
        case .done(let whole):
            // kept, so the loop still on screen reads as the same code, not a new one
            shade.isHidden = true
            text = whole
        case .progress(let share):
            say(percent: Int((share * 100).rounded(.down)), words: "SCANNING\nKeep the camera on the code")
            return
        case .rejected:
            say(percent: nil, words: "That code could not be read.\nHold the camera on it to try again.")
            return
        }
        // the camera reports the same code many times a second
        if text == lastCode, Date().timeIntervalSince(lastAt) < 3 { return }
        lastCode = text
        lastAt = Date()
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        print("[scan] handing the page a code, \(text.count) chars")
        onCode(text)
    }
}

/* The back camera that can focus on a phone screen a hand's width away.
 *
 * `AVCaptureDevice.default(for: .video)` is the wide lens alone, and on a
 * recent Pro that lens cannot focus nearer than about 20cm; the zoom in
 * `focusClose` was the workaround. The phone has an ultra-wide lens that
 * focuses at 2cm, and iOS switches to it by itself for close subjects — but
 * only when the capture device is the virtual one that holds both lenses.
 * So: the triple or dual-wide virtual camera when the phone has one, and the
 * plain wide lens otherwise. On the virtual
 * device `minimumFocusDistance` is the nearest of its lenses, so `focusClose`
 * leaves the zoom alone and the lens switch does the work. */
enum ScanCamera {
    static func pick() -> AVCaptureDevice? {
        let kinds: [AVCaptureDevice.DeviceType] = [.builtInTripleCamera, .builtInDualWideCamera, .builtInWideAngleCamera]
        let found = AVCaptureDevice.DiscoverySession(deviceTypes: kinds, mediaType: .video, position: .back).devices
        for kind in kinds { if let d = found.first(where: { $0.deviceType == kind }) { return d } }
        return AVCaptureDevice.default(for: .video)
    }
}
