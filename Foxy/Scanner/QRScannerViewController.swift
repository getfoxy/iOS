import UIKit
import AVFoundation

// MARK: - scanner

final class QRScannerViewController: UIViewController {

    enum ScanError: LocalizedError {
        case noCamera, denied, cancelled
        var errorDescription: String? {
            switch self {
            case .noCamera:  return "No camera available."
            case .denied:    return "Camera access is off. Turn it on in Settings."
            case .cancelled: return "Cancelled."
            }
        }
    }

    private let prompt: String
    private let done: (Result<String, Error>) -> Void
    private let session = AVCaptureSession()
    private var preview: AVCaptureVideoPreviewLayer?
    private var finished = false
    /// A token shown as an animated QR code (cashu.me) arrives a frame at a time.
    private let animated = AnimatedQRReader()
    private let label = UILabel()

    init(prompt: String, done: @escaping (Result<String, Error>) -> Void) {
        self.prompt = prompt
        self.done = done
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            configure()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] ok in
                DispatchQueue.main.async {
                    ok ? self?.configure() : self?.finish(.failure(ScanError.denied))
                }
            }
        default:
            finish(.failure(ScanError.denied))
        }

        addChrome()
    }

    private func configure() {
        guard let device = ScanCamera.pick(),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            finish(.failure(ScanError.noCamera))
            return
        }
        session.addInput(input)
        focusClose(device)

        /* As many pixels as the phone will give, because a dense code is the
         * hard case.
         *
         * Nothing set a preset, so the session ran at whatever it defaults to.
         * A Cashu request is 61 modules across; at the default that is a few
         * pixels per module once the code is anywhere but pressed against the
         * lens, and below about three the decoder simply never locks on. */
        for preset in [AVCaptureSession.Preset.hd4K3840x2160, .hd1920x1080] where session.canSetSessionPreset(preset) {
            session.sessionPreset = preset
            break
        }

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            finish(.failure(ScanError.noCamera))
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.insertSublayer(layer, at: 0)
        preview = layer

        // starting the session blocks, so keep it off the main thread
        DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
    }

    /* Focus on something close, which is where the codes are.
     *
     * Foxy's codes are usually on another phone's screen a hand's width away,
     * and the camera on a recent Pro cannot focus nearer than about 20cm — so
     * the picture is a blur, no amount of error correction saves it, and the
     * scan just sits there. Apple's own answer is to zoom until a code of a
     * realistic size fills enough of the frame at that distance, which is what
     * this does; on a phone that focuses closer it changes nothing.
     *
     * The code is taken as 25mm across — smaller than one on a phone screen,
     * so that a printed one still works — and wanted at a quarter of the frame.
     */
    private func focusClose(_ device: AVCaptureDevice) {
        guard (try? device.lockForConfiguration()) != nil else { return }
        defer { device.unlockForConfiguration() }

        if device.isFocusModeSupported(.continuousAutoFocus) {
            device.focusMode = .continuousAutoFocus
        }
        if device.isAutoFocusRangeRestrictionSupported {
            device.autoFocusRangeRestriction = .near
        }

        let closest = device.minimumFocusDistance          // millimetres, or -1
        guard closest > 0 else { return }

        let halfAngle = Float(device.activeFormat.videoFieldOfView) / 2 * .pi / 180
        guard halfAngle > 0 else { return }
        let wanted = (25 / Float(0.25)) / tan(halfAngle)   // mm the code must be at
        guard wanted > 0 else { return }

        let zoom = CGFloat(Float(closest) / wanted)
        guard zoom > 1 else { return }                     // it already focuses close enough
        device.videoZoomFactor = min(zoom, device.activeFormat.videoMaxZoomFactor)
    }

    private func addChrome() {
        label.text = prompt.isEmpty ? "Point at the code" : prompt
        label.textColor = .white
        label.font = .systemFont(ofSize: 17, weight: .medium)
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false

        let cancel = UIButton(type: .system)
        cancel.setTitle("Cancel", for: .normal)
        cancel.tintColor = .white
        cancel.titleLabel?.font = .systemFont(ofSize: 17)
        cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
        cancel.translatesAutoresizingMaskIntoConstraints = false

        let frame = UIView()
        frame.layer.borderColor = UIColor.white.withAlphaComponent(0.9).cgColor
        frame.layer.borderWidth = 2
        frame.layer.cornerRadius = 16
        frame.translatesAutoresizingMaskIntoConstraints = false

        view.addSubview(frame)
        view.addSubview(label)
        view.addSubview(cancel)

        NSLayoutConstraint.activate([
            frame.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            frame.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            frame.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.7),
            frame.heightAnchor.constraint(equalTo: frame.widthAnchor),

            label.bottomAnchor.constraint(equalTo: frame.topAnchor, constant: -28),
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),

            cancel.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
            cancel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
    }

    @objc private func cancelTapped() { finish(.failure(ScanError.cancelled)) }

    private func finish(_ result: Result<String, Error>) {
        guard !finished else { return }        // a steady hand fires this twice
        finished = true
        if session.isRunning {
            DispatchQueue.global(qos: .userInitiated).async { self.session.stopRunning() }
        }
        dismiss(animated: true) { self.done(result) }
    }
}

extension QRScannerViewController: AVCaptureMetadataOutputObjectsDelegate {
    func metadataOutput(_ output: AVCaptureMetadataOutput,
                        didOutput objects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        guard let object = objects.first as? AVMetadataMachineReadableCodeObject,
              let text = object.stringValue else { return }
        switch animated.receive(text) {
        case .notAnimated:
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            finish(.success(text))
        case .done(let whole):
            UINotificationFeedbackGenerator().notificationOccurred(.success)
            finish(.success(whole))
        case .progress(let share):
            // the camera stays open until every frame needed is in
            label.font = .systemFont(ofSize: 34, weight: .heavy)
            label.text = "SCANNING \(Int((share * 100).rounded(.down)))%\nKeep the camera on the code"
        case .rejected:
            label.text = "That animated code could not be read. Hold the camera on it to try again."
        }
    }
}
