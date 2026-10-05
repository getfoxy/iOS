import Foundation
import CoreBluetooth

/// Tap to pay over Bluetooth (TAP-TO-PAY.md).
///
/// Receiving: `tapReceiveStart` puts this phone **on the air** with what the
/// screen offers, until `tapReceiveStop`. It is the TAP button and nothing
/// else — no screen advertises on its own. The code the handshake makes reaches
/// the page as `FoxyWallet._tap({side:'receive', stage:'code', code})`.
///
/// Paying: `tapPayStart` starts **listening**, which the page does from home
/// and from the send screen, and answers `{"payload", "code"}` once the nearest
/// receiver's offer is in; its progress arrives as `_tap({side:'pay', stage})`.
/// `tapPayStop` ends it, and the waiting `tapPayStart` is answered with an error.
///
/// Which side owns the radio, and why, is in TapLink.swift's header.
extension FoxyBridge {

    /// The page sends what it is offering, which is a Lightning invoice, or a
    /// Cashu payment request, or both — see TapProtocol.isPayload. Two Foxys on
    /// one mint use the request and never touch Lightning.
    func handleTapReceiveStart(id: String, body: [String: Any]) {
        /* An empty payload is "go on the air, the offer is coming".
         *
         * Pressing TAP before the invoice or the onion address is ready used to
         * be refused, so the person waited about a second with a button that
         * did nothing. Nothing in the handshake needs the offer — it is M4, and
         * the four digits are settled at M3 — so this side can be found, talk,
         * and put the code on both screens while the page is still making the
         * thing to be paid (TapLink.offerSent). Anything non-empty still has to
         * be payable. */
        let payload = (body["payload"] as? String) ?? ""
        let early = (body["early"] as? Bool) ?? false
        guard payload.isEmpty || TapProtocol.isPayload(payload) else {
            resolve(id: id, text: nil, error: "Not something a payer could pay.")
            return
        }
        DispatchQueue.main.async {
            /* Pressing TAP again after a payment is a fresh receiver.
             *
             * The person closes the four digits off the QR and presses TAP for
             * the next customer. The old receiver cannot serve that: its
             * service UUID and its session keys were settled for the payer it
             * already had, and putting the same UUID back on the air would
             * also make two of one merchant's payments the same number twice.
             * So one that has taken its payer is retired and another is built.
             *
             * Unless a payment is still crossing, in which case nothing is
             * touched and the page is told why: the link is the only thing
             * carrying that money, and a button press is not a decision about
             * a payment already on the wire (TapLink.stop). */
            if let r = self.tapReceiver, r.takenOne {
                if r.busy {
                    self.resolve(id: id, text: nil,
                                 error: "That payment is still going through. A moment.")
                    return
                }
                /* Not while a payer is deciding on the offer they have. The
                 * split screen's share got its invoice seven seconds after a
                 * payer linked, the page offered the screen again, and this
                 * retired the receiver under them: their payment went into a
                 * service that no longer existed and timed out forty seconds
                 * later.
                 * The offer they hold is the one they pay; the new one waits
                 * for the next customer. */
                if r.withPayer {
                    r.early = early
                    r.update(payload: payload)
                    self.resolve(id: id, text: "ok", error: nil)
                    return
                }
                _ = r.stop()
                self.tapReceiver = nil
            }
            if let r = self.tapReceiver {
                r.early = early
                r.update(payload: payload)
                // pressing TAP on a screen that is already on the air is a no-op
                r.arm()
            } else {
                let r = TapRx(payload: payload, onEvent: { [weak self] stage, code in
                    self?.pushTap(side: "receive", stage: stage, code: code)
                }, onPaid: { [weak self] body, tell in
                    /* The same door a payment over Tor comes through, and now
                     * with somebody behind it.
                     *
                     * It used to pass an empty answer id, reasoning that "the
                     * Bluetooth write was acknowledged piece by piece, so the
                     * payer already knows it landed". Both halves were wrong.
                     * The payment arrives as a notification, which LE does not
                     * acknowledge at all — and landing is not the question. The
                     * payer deletes its only copy of the payment when M6 says
                     * ok, so M6 has to mean the page wrote it down, not that
                     * the radio caught it.
                     *
                     * The onion path's own registry, unchanged: `_requestPaid`
                     * answers through `inboxAnswer`, `handleInboxAnswer` takes
                     * the key out so it can fire only once, clamps the status to
                     * 200/409/422 and builds the same JSON the onion would have
                     * sent. The tap wire wants the reason on its own, so it is
                     * read back out here. */
                    guard let self else { return }
                    let key = MintCircuit.label(nil)
                    self.inboxAnswers[key] = { status, said in
                        var why = ""
                        if let d = said.data(using: .utf8),
                           let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
                           let text = o["error"] as? String { why = text }
                        tell(status, why)
                    }
                    /* Dropped a little after the receiver has given up on it, so
                     * a page that answers very late finds nothing rather than
                     * writing a second M6. */
                    DispatchQueue.main.asyncAfter(deadline: .now() + TapRx.resultWait + 5) {
                        [weak self] in self?.inboxAnswers[key] = nil
                    }
                    self.evaluate("window.FoxyWallet && window.FoxyWallet._requestPaid"
                                  + " && window.FoxyWallet._requestPaid("
                                  + Self.literalStatic(body) + ", " + Self.literalStatic(key)
                                  + ", \"tap\")")
                }, onQuote: { [weak self] text in
                    /* M10: the payer's price, and what it makes of the dollar
                     * amount this phone asked for. Nothing has moved — it is a
                     * number for a person to agree to, and the page is where
                     * that happens. */
                    self?.evaluate("window.FoxyWallet && window.FoxyWallet._tapQuote"
                                  + " && window.FoxyWallet._tapQuote("
                                  + Self.literalStatic(text) + ")")
                })
                r.turned = self.tapTurned
                r.early = early
                self.tapReceiver = r
                r.start()
                /* Pressing TAP is the arming: this phone goes on the air
                 * because somebody chose to be paid, and comes off it when the
                 * payment is done or they leave. Nothing advertises on its
                 * own — that is the whole of the privacy argument for putting
                 * the receiver back on the air (TapLink.swift). */
                r.arm()
            }
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    func handleTapReceiveStop(id: String, body: [String: Any]) {
        DispatchQueue.main.async {
            /* Held, not dropped, while a payment is crossing. `stop` answers
             * false then and the receiver has to stay alive to finish carrying
             * it — letting go of the reference here would take the link with it
             * and strand the money on the paying phone, which is the bug this
             * exists for (TapLink.stop). The page is told "ok" either way: it
             * has left the screen and there is nothing for it to wait on. */
            if let r = self.tapReceiver {
                let done = r.stop { [weak self] in
                    if self?.tapReceiver === r { self?.tapReceiver = nil }
                }
                if done { self.tapReceiver = nil }
            }
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    func handleTapPayStart(id: String, body: [String: Any]) {
        /* `now`: the person pressed TAP TO PAY on the toast. Not a new listen
         * — the one already running is told to take the receiver it has been
         * hearing, and this call is answered at once; the offer still comes
         * back on the listen's own call. */
        if body["now"] as? Bool == true {
            DispatchQueue.main.async {
                self.tapPayer?.connectNearby()
                self.resolve(id: id, text: "ok", error: nil)
            }
            return
        }
        DispatchQueue.main.async {
            self.endTapPay("Started again.")
            self.tapPayId = id
            let payer = TapTx(onStage: { [weak self] stage in
                // `nearby` carries which edge of this screen the mark goes on (TapEdges)
                self?.pushTap(side: "pay", stage: stage,
                              code: stage == .nearby ? self?.tapPayer?.edge
                                  : stage == .sending ? (self?.tapPayer).map { String($0.progress) } : nil)
            }, onChange: { [weak self] token, kept in
                /* Change arriving is money, so the page is asked and its answer is
                 * what goes back as M8 — not this closure's, and not the radio's.
                 * `changeKept` is how the page answers, once it has written the
                 * token down; no answer and the receiver's own wait ends it. */
                guard let self, self.tapPayId == nil || self.tapPayId == id else { kept(false); return }
                self.tapChangeKeep = kept
                self.evaluate("window.FoxyWallet && window.FoxyWallet._tapChange && window.FoxyWallet._tapChange("
                             + Self.literalStatic(token) + ")")
            }, onTerms: { [weak self] text in
                /* M11: they agreed the price and sent the request, now in sats.
                 * Handed to the page exactly as the first offer was — it is the
                 * same conversation, reaching the number both sides accept. */
                self?.evaluate("window.FoxyWallet && window.FoxyWallet._tapTerms && window.FoxyWallet._tapTerms("
                              + Self.literalStatic(text) + ")")
            }, done: { [weak self] payload, code in
                guard let self, self.tapPayId == id else { return }
                self.tapPayId = nil
                /* The payer is kept, not dropped. Its link to the receiver is
                 * still open and the payment goes back over it (tapSend); the
                 * old code let go here, when the offer was all that crossed. */
                let text = "{\"payload\":" + Self.literalStatic(payload) + ",\"code\":" + Self.literalStatic(code) + "}"
                self.resolve(id: id, text: text, error: nil)
            })
            self.tapPayer = payer
            /* Listening only. This side never advertises, so there is nothing
             * to arm: it starts looking the moment the page asks, which is on
             * the home and send screens, and stops when the page says so or
             * Foxy leaves the foreground. */
            payer.start()
        }
    }

    /// {body}: the payment, handed to the receiver over the link this tap
    /// already has. Answers "ok", or why it could not go — and the page falls
    /// back to the request's own transport, which is what it used to do.
    func handleTapSend(id: String, body: [String: Any]) {
        guard let text = body["body"] as? String, !text.isEmpty else {
            resolve(id: id, text: nil, error: "There is nothing to hand over.")
            return
        }
        DispatchQueue.main.async {
            guard let payer = self.tapPayer else {
                self.resolve(id: id, text: nil, error: "That phone is no longer connected.")
                return
            }
            payer.send(text) { [weak self] how in
                guard let self else { return }
                switch how {
                /* M6, as the receiver sealed it, straight through to the page:
                 * it is where every other delivery answer is read, so there is
                 * one parser rather than two. */
                case .answered(let said): self.resolve(id: id, text: said, error: nil)
                // only a link that went falls back to the request's own transport
                case .lost(let why): self.resolve(id: id, text: nil, error: why)
                }
            }
        }
    }

    /* The first-install Bluetooth screen's APPROVE (foxy-tor-gate.js). Making a
     * central manager is what puts iOS's Bluetooth question on screen; the
     * answer is read back from `CBManager.authorization` once the manager
     * reports a state. Answered twice: on the action's own id, and to the
     * gate's `__foxyBluetoothAnswer`, because the gate is up before the wallet
     * page that would otherwise hear the reply. Nothing else: no scan, no
     * advertisement, and the manager is let go once it has answered. */
    func handleBluetoothAsk(id: String, body: [String: Any]) {
        DispatchQueue.main.async {
            let ask = BluetoothAsk { [weak self] state in
                guard let self else { return }
                self.bluetoothAsk = nil
                self.evaluate("window.__foxyBluetoothAnswer && window.__foxyBluetoothAnswer(" + Self.literalStatic(state) + ")")
                self.resolve(id: id, text: state, error: nil)
            }
            self.bluetoothAsk = ask
            ask.start()
        }
    }

    func handleTapPayStop(id: String, body: [String: Any]) {
        DispatchQueue.main.async {
            self.endTapPay("Stopped.")
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    /* A shake presses TAP (TAP-TO-PAY.md). iOS decides what a shake is —
     * the same gesture as shake to undo — and the host controller hears it
     * (WebHostController.motionEnded). The page arms it only while the receive
     * invoice screen has something to offer, and presses the button itself, so
     * every rule the button has applies. Both idempotent. */
    func handleShakeStart(id: String, body: [String: Any]) {
        DispatchQueue.main.async {
            if !self.shakeArmed { print("[foxy] tap: shake to tap on") }
            self.shakeArmed = true
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    func handleShakeStop(id: String, body: [String: Any]) {
        DispatchQueue.main.async {
            if self.shakeArmed { print("[foxy] tap: shake to tap off") }
            self.shakeArmed = false
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    /// Foxy is back in front. A payer with a payment handed over asks the
    /// receiver to say again whatever it said while this app was suspended.
    func tapWoke() {
        tapPayer?.askAgain()
    }

    /// The phone is the other way up, or back. The page turns its invoice
    /// screen round on it (TAP-TO-PAY.md, "upside down").
    func turned(upsideDown: Bool) {
        // The flip is off, so the payer is not told to swap
        // its mark either: both screens stay as the pair's edges say.
        evaluate("window.FoxyWallet && window.FoxyWallet._turned && window.FoxyWallet._turned(" + (upsideDown ? "true" : "false") + ")")
    }

    /// The phone was shaken. Told to the page only while armed.
    func shaken() {
        guard shakeArmed else {
            print("[foxy] tap: shaken, but shake to tap is off")
            return
        }
        print("[foxy] tap: shaken; pressing TAP")
        pushTap(side: "receive", stage: .shake, code: nil)
    }

    /// Stops both sides: the page went away.
    func stopTap() {
        DispatchQueue.main.async {
            self.shakeArmed = false
            self.endTapPay("Stopped.")
            /* The page going away is the one case where a payment in flight
             * cannot be finished — nothing is left to write it down — so this
             * does not wait. `stop` still answers, and the reference goes. */
            _ = self.tapReceiver?.stop()
            self.tapReceiver = nil
        }
    }

    private func endTapPay(_ why: String) {
        tapPayer?.stop()
        tapPayer = nil
        if let waiting = tapPayId {
            tapPayId = nil
            resolve(id: waiting, text: nil, error: why)
        }
    }

    /* The receiver hands change back over the link the payment came in on.
     *
     * Its own action rather than widening `inboxAnswer`, which is shared with the
     * onion path and clamps to a status and three hundred characters — a token is
     * neither. Refused when there is no live receiver or the link has gone, so the
     * page learns now rather than believing change went out.
     */
    func handleTapChange(id: String, body: [String: Any]) {
        let token = (body["body"] as? String) ?? ""
        DispatchQueue.main.async {
            guard !token.isEmpty else {
                self.resolve(id: id, text: nil, error: "There is no change to send.")
                return
            }
            guard let r = self.tapReceiver else {
                self.resolve(id: id, text: nil, error: "That phone is no longer connected.")
                return
            }
            /* Answered when the payer says it kept the change, not when the
             * bytes have gone. The page writes "given back" on this answer, and
             * a payer that left before reading them left the change with
             * nobody.
             *
             * Seven seconds, then the page is told it was not handed over and
             * shows the code. It was twenty, and for those twenty the receiver
             * stood on its home screen with nothing to show the person in
             * front of it. A payer's page answers in
             * a fifth of a second offline and about four online. One that
             * answers after the seven is still heard: the page is told then,
             * takes the code down and writes "given back". */
            let wait = ChangeHandover()
            let answer: (Bool) -> Void = { [weak self] kept in
                switch wait.heard(kept: kept) {
                case .kept?:
                    self?.resolve(id: id, text: "ok", error: nil)
                case .notHanded?:
                    self?.resolve(id: id, text: nil, error: "The payer's phone did not say it kept the change.")
                case .late?:
                    print("[tap] receive: the payer kept the change after this phone had stopped waiting")
                    self?.evaluate("window.FoxyWallet && window.FoxyWallet._tapChangeKeptLate && window.FoxyWallet._tapChangeKeptLate()")
                case nil:
                    break
                }
            }
            r.onChangeAnswered = answer
            guard r.sendChange(token) else {
                r.onChangeAnswered = nil
                _ = wait.heard(kept: false)
                self.resolve(id: id, text: nil, error: "That phone is no longer connected.")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 7) { [weak r] in
                guard !wait.answered else { return }
                answer(false)
                // still listening: a late "kept" comes through the same door
                r?.onChangeAnswered = answer
            }
        }
    }

    /* The receiver's page, saying a person is being asked about the payment.
     *
     * This is what becomes M9. It carries nothing and decides nothing: M6 is
     * still the answer, and this only says "do not give up on us yet" so the
     * payer's phone can wait for a person instead of for a swap, and say so.
     *
     * Resolved rather than refused when there is no live link: the page must not
     * be made to care. A card is already on screen at this point and the
     * person's answer still has to go somewhere, and a rejection here would only
     * teach the page to guess about the radio.
     */
    func handleTapAsking(id: String, body: [String: Any]) {
        DispatchQueue.main.async {
            if let r = self.tapReceiver, r.sendAsking() {
                self.resolve(id: id, text: "ok", error: nil)
            } else {
                print("[tap] receive: nobody to tell that a person is deciding")
                self.resolve(id: id, text: "no link", error: nil)
            }
        }
    }

    /* The payer's page, quoting its price for a dollar amount (M10).
     *
     * A receiver with no route asks in dollars and leaves the conversion to the
     * phone that has a current price. Nothing moves on this: it is a number for
     * a person to agree to, and until they do, the payer still has its sats.
     */
    func handleTapQuote(id: String, body: [String: Any]) {
        let text = (body["body"] as? String) ?? ""
        DispatchQueue.main.async {
            guard let payer = self.tapPayer, payer.sendQuote(text) else {
                self.resolve(id: id, text: nil, error: "That phone is no longer connected.")
                return
            }
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    /* The receiver's page, agreeing that price and sending the request (M11).
     *
     * The same conversation reaching the number both sides accept. It carries a
     * request as the offer does, so it is padded the same way.
     */
    func handleTapTerms(id: String, body: [String: Any]) {
        let text = (body["body"] as? String) ?? ""
        DispatchQueue.main.async {
            guard let r = self.tapReceiver, r.sendTerms(text) else {
                self.resolve(id: id, text: nil, error: "That phone is no longer connected.")
                return
            }
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    /* The receiver's page, saying this payment owes change back.
     *
     * Said as soon as the amount is read, not when the change exists: making it
     * is a swap at the mint, and the link's own teardown is faster than the mint
     * is. Nothing is sent by this — it only stops the link being retired out
     * from under the change that is being made for it.
     */
    func handleTapChangeDue(id: String, body: [String: Any]) {
        DispatchQueue.main.async {
            self.tapReceiver?.expectChange()
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    /* The payer's page, saying it has the change written down — or has not.
     *
     * This is what becomes M8. It is the page's word deliberately: bytes arriving
     * says nothing about money kept, which is the lesson M6 already carries. */
    func handleTapChangeKept(id: String, body: [String: Any]) {
        let kept = (body["kept"] as? Bool) ?? false
        DispatchQueue.main.async {
            guard let answer = self.tapChangeKeep else {
                self.resolve(id: id, text: nil, error: "No change is waiting to be kept.")
                return
            }
            self.tapChangeKeep = nil
            answer(kept)
            self.resolve(id: id, text: "ok", error: nil)
        }
    }

    private func pushTap(side: String, stage: TapStage, code: String?) {
        var js = "{\"side\":\"" + side + "\",\"stage\":\"" + stage.rawValue + "\""
        if let code, code.count == 4, code.allSatisfy(\.isNumber) { js += ",\"code\":\"" + code + "\"" }
        // `nearby` says which edge of this screen the CONNECT TO PAY mark goes on
        if code == "left" || code == "right" { js += ",\"edge\":\"" + (code ?? "") + "\"" }
        // how far a large payment has got across, on either side
        if stage == .sending || stage == .receiving, let code, let pct = Int(code), (0...100).contains(pct) {
            js += ",\"pct\":" + String(pct)
        }
        js += "}"
        evaluate("window.FoxyWallet && window.FoxyWallet._tap && window.FoxyWallet._tap(" + js + ")")
    }
}


/// One Bluetooth question, answered as "allowed", "denied", "off", "unsupported"
/// or, after a minute with no word from iOS, "unknown".
final class BluetoothAsk: NSObject, CBCentralManagerDelegate {
    private var manager: CBCentralManager?
    private var done: ((String) -> Void)?
    private var timer: Timer?

    init(_ done: @escaping (String) -> Void) { self.done = done }

    func start() {
        manager = CBCentralManager(delegate: self, queue: .main,
                                   options: [CBCentralManagerOptionShowPowerAlertKey: false])
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in self?.finish("unknown") }
    }

    private func finish(_ state: String) {
        timer?.invalidate(); timer = nil
        guard let d = done else { return }
        done = nil
        manager?.delegate = nil
        manager = nil
        d(state)
    }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        switch CBManager.authorization {
        case .denied, .restricted: finish("denied")
        case .notDetermined: return                     // the question is still on screen
        default:
            switch central.state {
            case .unsupported: finish("unsupported")
            case .poweredOff: finish("off")
            case .unknown, .resetting: return
            default: finish("allowed")
            }
        }
    }
}
