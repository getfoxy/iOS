import Foundation
import CoreBluetooth

/// What either side tells the page as it goes (FoxyBridge+Tap.swift).
enum TapStage: String {
    case searching, far, connecting, linked
    /// A payment large enough to take a while is on its way across: how far,
    /// as a percentage, on the payer's side and the receiver's.
    case sending, receiving
    case code
    /// M9: a person on the receiver's phone is deciding about this payment.
    case asking
    /// The receiver's payer left after the link was made and before any
    /// result was sent: the payment may be sitting on their screen as a code.
    case gone
    /// The receiver's phone was shaken: the page presses TAP (TAP-TO-PAY.md).
    case shake
    /// The payer can hear a receiver within `nearbyDbm`: its screen says TAP TO PAY.
    case nearby
    case off, denied, unsupported
}

private func cbState(_ s: CBManagerState) -> TapStage? {
    switch s {
    case .poweredOn: return nil
    case .poweredOff, .resetting: return .off
    case .unauthorized: return .denied
    default: return .unsupported
    }
}

/// Framing, both ways: two bytes of length, then the message.
private func framed(_ body: Data) -> Data {
    Data([UInt8(body.count >> 8), UInt8(body.count & 0xff)]) + body
}

/* Which side owns the radio, and why it is this way round.
 *
 * The receiver advertises and the payer listens. It has been both ways:
 *
 * Earlier the receiver advertised, and it was changed because a till
 * that advertises all day is a beacon — one phone, one place — and everything
 * iOS serves to whoever connects goes with it: its battery level, its model,
 * and very likely its user's name. A week of listening outside a shop was a
 * week of tracking one device.
 *
 * It is back, with the thing that made it a beacon removed: **this side goes on
 * the air only when somebody presses TAP**, for the seconds a payment takes, on
 * a service UUID that is new every time. What is left of that leak is real but
 * bounded — a scanner beside a busy till still collects the merchant's device
 * name once per payment — and it is the merchant's, not the customer's. The
 * customer now only listens, and listening emits nothing anybody can attribute.
 *
 * What it buys is the thing that could not be had the other way round: the
 * payer never has to find a screen first. Foxy listens from home and from the
 * send screen, so a phone in somebody's hand is already able to pay, and the
 * tap is the merchant's action alone.
 *
 * The protocol did not move. `TapSession` names its six messages by role, and
 * the payer still speaks first — as a central it connects, subscribes and then
 * writes, which is the same order over a different transport.
 */

/// The receiving phone, which goes on the air when TAP is pressed.
///
/// Advertising only on a press is the whole of the privacy argument above: this
/// is not a till standing on the air, it is one payment's worth of seconds. The
/// service UUID is fresh every time, so two payments taken by the same merchant
/// are not the same number twice, and the advertisement carries nothing else —
/// no name, no amount, no code.
///
/// Being the peripheral means this side hears nothing until a payer subscribes,
/// and says nothing until the payer speaks. A phone that connects and never
/// subscribes — the payer's warm link — is invisible here, which is what makes
/// warming free.
///
/// Main queue only.
final class TapReceiver: NSObject, CBPeripheralManagerDelegate {

    private let onEvent: (TapStage, String?) -> Void
    /// The payment, and the answer the page must drive M6 with.
    private let onPaid: (String, @escaping (Int, String) -> Void) -> Void
    /* M10, at the receiver: the payer's price and what it makes of the dollar
     * amount. Defaulted to doing nothing, so a caller with no price leg is
     * unchanged. */
    private let onQuote: (String) -> Void
    private var payload: String
    private var manager: CBPeripheralManager?
    private var outChar: CBMutableCharacteristic?

    /// New every time. A scanner that saw the last one learns nothing here.
    private let service = TapCrypto.newService()
    private var inId: CBUUID { CBUUID(nsuuid: TapCrypto.inCharacteristic(for: service)) }
    private var outId: CBUUID { CBUUID(nsuuid: TapCrypto.outCharacteristic(for: service)) }
    private func nearId(_ edge: String) -> CBUUID { CBUUID(nsuuid: TapCrypto.nearCharacteristic(for: service, edge: edge)) }
    /* Payers that have said they are near, and nothing more. No handshake, no
     * key, no offer: a subscribe on the third door is the whole message. It
     * puts CONNECT TO PAY on this screen. A peripheral cannot measure how far
     * a central is, so this is the payer's own word for "near" — and anything
     * in radio range can say it. It changes a picture and nothing else. */
    private var nearCentrals: [UUID: String] = [:]
    private var nearChars: [CBMutableCharacteristic] = []
    /* This phone is top-down. The mark on this screen is moved by the page; the
     * payer's cannot be, unless it is told — the edge of this phone it has to
     * meet is now on the other side of it. One byte down
     * the near door the payer is already listening on: bit 0 turned, and
     * bit 1 "early" — on the air from the amount screen, nothing to pay yet,
     * so the payer keeps its card down until NEXT is pressed. Bits an older
     * Foxy never sets read as upright and ready. */
    var turned = false { didSet { if turned != oldValue { tellTurned() } } }
    var early = false { didSet { if early != oldValue { tellTurned() } } }
    private var doorByte: Data { Data([(turned ? 1 : 0) | (early ? 2 : 0)]) }
    /* To each payer by name, on the door it chose. Sent to "everyone
     * subscribed" it did not arrive: a payer heard "still on the amount screen"
     * when it subscribed and never heard that the receiver had moved on, so its
     * card stayed down until the app was put away and brought back. And one the
     * radio would not take is sent again when it says it is ready. */
    private var nearWho: [UUID: CBCentral] = [:]
    /* Who is still owed the byte, and how many times each refused it.
     *
     * One flag for everyone was a storm. Two payers were subscribed on one
     * receiver and one of them — a phone that had wandered off without
     * unsubscribing, as far as the radio could tell — refused the byte every
     * time. The flag stayed up, `peripheralManagerIsReady` fired, the byte
     * was sent to BOTH again, the dead one refused again: 450 lines a second
     * for fifteen seconds, 8,500 in all, the diary's first megabyte gone and
     * the radio busy enough that the live payer kept hearing "still on the
     * amount screen" after NEXT was pressed. Now only the ones
     * owed are told again, a payer that refuses forty times running is
     * dropped as not here, and the line is printed when it changes. */
    private var doorOwedTo: Set<UUID> = []
    private var doorRefusals: [UUID: Int] = [:]
    private var doorSaid = ""
    private func tellTurned(only: Set<UUID>? = nil) {
        guard let m = manager else { return }
        for (id, edge) in nearCentrals {
            if let only, !only.contains(id) { continue }
            guard let c = nearWho[id], let ch = nearChars.first(where: { $0.uuid == nearId(edge) }) else { continue }
            if m.updateValue(doorByte, for: ch, onSubscribedCentrals: [c]) {
                doorOwedTo.remove(id)
                doorRefusals[id] = nil
                continue
            }
            let n = (doorRefusals[id] ?? 0) + 1
            doorRefusals[id] = n
            if n >= 40 {
                print("[tap] receive: a payer nearby took no door byte in \(n) tries; it is not told again")
                doorOwedTo.remove(id)
                doorRefusals[id] = nil
                nearCentrals[id] = nil
                nearWho[id] = nil
                if nearCentrals.isEmpty { onEvent(.far, nil) }
            } else {
                doorOwedTo.insert(id)
            }
        }
        let line = "told \(nearCentrals.count) payer(s) nearby: "
            + "\(early ? "amount screen" : "invoice screen"), \(turned ? "top-down" : "upright")"
            + (doorOwedTo.isEmpty ? "" : " — the radio was busy for \(doorOwedTo.count), to be said again")
        if line != doorSaid {
            doorSaid = line
            print("[tap] receive: " + line)
        }
    }

    private var session: TapSession?
    private var talkingTo: UUID?
    private var arriving = TapProtocol.Bytes()
    private var queued: [(CBCentral, Data)] = []
    private var added = false
    private var armed = false
    private var linked = false
    private var finished = false
    /// A subscriber has this long to send M1. A phone that subscribes and
    /// says nothing is not a payer — a scanner, a curious app — and with the
    /// receiver arming itself on every invoice it would otherwise
    /// hold every till it touched off the air for as long as it stayed.
    static let handshakeWait: TimeInterval = 5
    private var handshakeTimer: Timer?
    /* The offer is M4, and M4 can wait.
     *
     * Going on the air used to mean having something to offer: the page held
     * the press until `railRequest` had an onion address, about a second, and
     * the person stood there with a QR and a button that did nothing yet.
     *
     * Nothing in the handshake needs the offer. The four digits come from the
     * transcript — the service, both public keys, both nonces — and the offer
     * is not in it, so M1 to M3 can finish, both screens can show the code, and
     * the invoice can follow the moment the page has one. What that buys is the
     * whole of the wait: the phones are already talking while the address is
     * still being published.
     *
     * Sent once, and only when there is really something to send. An empty M4
     * would be a payer told to pay nothing. */
    private var offerSent = false
    private var linkedCentral: CBCentral?
    /// Change has been sealed and sent, and the payer has not said it kept it.
    private var changeOwed = false
    /// The payer said it kept the change; this side is done.
    private var changeTaken = false
    /* What became of change that was sent: true when the payer says it kept
     * it (M8), false when the payer went, or this receiver stopped, first.
     * Bytes leaving is not money kept — a payer that backgrounded 1.5 s after
     * paying never read them, and this side wrote "given back" on a payment
     * whose change nobody held. Called
     * once. */
    var onChangeAnswered: ((Bool) -> Void)?
    private func changeAnswered(_ kept: Bool) {
        let tell = onChangeAnswered
        onChangeAnswered = nil
        tell?(kept)
    }
    /// Whoever is listening, so a result can be addressed after the fact.
    private var subscribed: [CBCentral] = []

    /* M6 waits for the page.
     *
     * It used to be sealed on the line after the bytes arrived — `{"ok":true}`,
     * before `_requestPaid` had parsed, checked or written down anything. The
     * payer believes M6: `payRequest` resolves, `requestDelivered` runs, and
     * `forgetClaimedToken` deletes the token's text, blanks the audit record's
     * inputs and drops the last-token record. So a receiver that legitimately
     * refused a moment later — its page reloaded and the request no longer
     * open, the mint no longer matching, a duplicate — left the payer holding
     * no copy of a payment nobody had taken.
     *
     * The onion transport never had this: it holds the HTTP response open until
     * the page answers. This is that, over Bluetooth.
     *
     * And a clock, because the page may never answer: the web content process
     * can die and be reloaded mid-payment. Twenty-five seconds is long enough
     * for a redeem over a cold circuit and short enough to beat the payer's own
     * wait, so it hears a sealed answer rather than silence. */
    static let resultWait: TimeInterval = 25
    /* And how long once a person is in it (M9). Long enough to read a warning
     * about somebody's money, short enough that a phone put down mid-payment
     * does not hold the payer's link open all afternoon. */
    static let askingWait: TimeInterval = 90
    private var resultTimer: Timer?
    private var resultSent = false
    /// A payment has been handed to the page. One per receiver, whatever the
    /// clock is doing.
    private var paymentHeard = false
    /// A large payment on its way in: the bytes it said to expect, those of
    /// the parts already in, and the last percentage told to the page.
    private var expecting = 0
    private var arrivedBefore = 0
    private var arrivedSaid = TapProgress()
    private var stopping = false

    init(payload: String, onEvent: @escaping (TapStage, String?) -> Void,
         onPaid: @escaping (String, @escaping (Int, String) -> Void) -> Void = { _, _ in },
         onQuote: @escaping (String) -> Void = { _ in }) {
        self.payload = payload
        self.onEvent = onEvent
        self.onPaid = onPaid
        self.onQuote = onQuote
        super.init()
    }

    func start() {
        manager = CBPeripheralManager(delegate: self, queue: .main,
                                      options: [CBPeripheralManagerOptionShowPowerAlertKey: false])
    }

    /// What this screen is offering. It may arrive after the payer does — see
    /// `offerSent` — and the moment it is real it goes out as M4.
    func update(payload: String) {
        self.payload = payload
        sendOfferIfReady()
    }

    private func sendOfferIfReady() {
        guard linked, !offerSent, !finished, let made = session, let c = linkedCentral,
              TapProtocol.isPayload(payload) else { return }
        guard let offer = made.sealOffer(payload) else {
            print("[tap] receive: the offer would not seal")
            return
        }
        offerSent = true
        push(offer, to: c)
    }

    /// On the air. Nothing is advertised before this, and this is the press of
    /// the TAP button and nothing else.
    func arm() {
        guard !armed else { return }
        armed = true
        advertise()
    }

    /// Whether a payment is crossing right now: its pieces are arriving, or it
    /// has arrived and the page has not said what became of it.
    /* Whether this receiver is in the middle of something a teardown would break.
     *
     * The result, as before — and now change as well. Change is money leaving this
     * phone for the other one, and it is not finished when the bytes go: it is
     * finished when the payer's page says it kept it (M8). Between those two the
     * link has to stay up, or the change is lost from both sides at once — gone
     * from here, never written down there.
     *
     * `changeOwed` is what makes `stop(whenIdle:)` defer, what stops the two
     * second teardown after M6 firing under it, and what makes the bridge refuse
     * to retire this receiver when the merchant presses NEXT PAYER. */
    var busy: Bool {
        if changeOwed && !changeTaken { return true }
        return !resultSent && (resultTimer != nil || !arriving.buffer.isEmpty)
    }

    /// Whether this one has had its payer. **It cannot be armed again.**
    ///
    /// A `TapReceiver` is one payment's worth of radio: the service UUID is
    /// made once at init and the session's keys are settled against it, so
    /// re-arming the same object would put the same number back on the air and
    /// hand a second payer a conversation the first one's keys belong to.
    ///
    /// Pressing TAP after a payment is therefore a *new* receiver, with a new
    /// UUID — which is also what makes two payments by one merchant
    /// unlinkable. The bridge reads this to know which it is
    /// (FoxyBridge+Tap.swift).
    ///
    /// **The offer, not the handshake.** This asked `linked`, which is true the
    /// moment the keys agree — and the whole point of arming before the QR is
    /// ready is that the offer arrives *after* that. So the page handing over
    /// the real offer retired the very receiver it was for, the payer's link
    /// died with it, and the payer buzzed at a peripheral that no longer
    /// existed while the receiver happily showed a code. A receiver is spent once it has
    /// handed an offer to somebody, and not before. */
    /* Change back to the payer, over the link the payment just crossed.
     *
     * Sealed only when there is somewhere to push it, because a message sealed and
     * then dropped moves this side's counter and not the other's, and every later
     * message on the link fails to open. That only bites while the link survives —
     * `reallyStop` takes the session with the queue — so the guard is simply: do
     * not seal without a central to send it to. */
    /// Change is owed, and the link must be kept for it.
    ///
    /// `changeOwed` used to be set inside `sendChange`, which runs only once the
    /// swap that makes the change has come back from the mint — three and a half
    /// seconds in testing. The receiver's own teardown fires two
    /// seconds after it answers M6, so the link was gone before the guard that
    /// protects it was set, and the change had nowhere to go (in one log the link went down a second before the change was ready).
    ///
    /// Told the moment the page knows, which is when it reads the amount, not
    /// when it has the money to hand back.
    func expectChange() {
        guard linked, !finished else { return }
        changeOwed = true
        changeTaken = false
        print("[tap] receive: change is owed, so this link stays up for it")
    }

    /// M11: the price was agreed; here is the request, now in sats.
    ///
    /// The offer that started this named dollars and no amount, because a phone
    /// with no route has a price that may be hours old. This is the same
    /// conversation reaching the number both sides accept — and nothing has left
    /// the payer yet, which is why the order is this way round.
    func sendTerms(_ text: String) -> Bool {
        guard linked, !finished, let made = session, let m = manager,
              let central = subscribed.first(where: { $0.identifier == talkingTo }),
              let sealed = made.sealTerms(text) else { return false }
        _ = m
        push(sealed, to: central)
        print("[tap] receive: the price was agreed; the request is on its way")
        return true
    }

    /// M9: tell the payer a person here is being asked about their payment.
    ///
    /// Sent once, between M5 and M6, and only when both phones are offline: the
    /// page cannot settle unlocked ecash without a route, so it puts the question
    /// to its user, and a person takes longer than a swap. The payer's clock is
    /// what this is for. It carries nothing — not the amount, not the reason,
    /// nothing about who is being asked — because none of that is the payer's
    /// business and a message with no contents cannot leak any of it.
    func sendAsking() -> Bool {
        guard linked, !finished, !resultSent, let made = session, let m = manager,
              let central = subscribed.first(where: { $0.identifier == talkingTo }),
              let sealed = made.sealAsking() else { return false }
        _ = m
        /* The page's own clock goes too. Twenty-five seconds is right for a swap
         * over a cold circuit and wrong for somebody reading a warning; ninety is
         * long enough to read it and still short enough that a phone put in a
         * pocket does not hold the payer for ever. */
        resultTimer?.invalidate()
        resultTimer = Timer.scheduledTimer(withTimeInterval: Self.askingWait,
                                           repeats: false) { [weak self] _ in
            self?.sealResult(504, "They did not answer in time.")
        }
        push(sealed, to: central)
        print("[tap] receive: telling the payer a person is deciding")
        return true
    }

    func sendChange(_ text: String) -> Bool {
        guard linked, !finished, let made = session, let m = manager,
              let central = subscribed.first(where: { $0.identifier == talkingTo }) else {
            print("[tap] receive: no link to hand the change over: linked \(linked), finished \(finished), "
                  + "a payer subscribed \(subscribed.contains { $0.identifier == talkingTo })")
            return false
        }
        guard let sealed = made.sealChange(text) else {
            print("[tap] receive: the change would not seal (\(text.utf8.count) bytes)")
            return false
        }
        _ = m
        changeOwed = true
        changeTaken = false
        push(sealed, to: central)
        print("[tap] receive: change sent, waiting for the payer to keep it")
        return true
    }

    var takenOne: Bool { offerSent }

    /// A payer has the offer and has not paid yet: they are deciding on it.
    /// The screen's offer may change under them — a split's share gets its
    /// invoice a few seconds after the QR goes up — and that is no reason to
    /// take their link away.
    var withPayer: Bool { linked && offerSent && !resultSent }

    /// Ends the listen. **Answers false when it did not**, because a payment is
    /// mid-flight and the link is the only thing carrying it — the caller must
    /// keep this object alive until `whenIdle` fires.
    ///
    /// A screen change used to end it outright. On the collecting phone the
    /// NEXT PAYER button leaves the share's screen, `syncTap` sees nothing to
    /// advertise and stops the link — and the person pressed it 150 ms after the
    /// payer had begun writing 4096 bytes. The payer got "that phone went away
    /// before it said what became of the payment", fell back to the onion,
    /// spent two minutes failing, and 24 sats ended up stranded as a token on a
    /// phone that cannot spend them, because they are locked to the phone that
    /// walked away.
    ///
    /// A person leaving a screen is not a decision about a payment already on
    /// the wire. The link outlives the screen by as long as the answer is
    /// allowed to take, and no longer.
    func stop(whenIdle: (() -> Void)? = nil) -> Bool {
        if busy, !stopping {
            stopping = true
            print("[tap] receive: a payment is crossing; the link stays until it is answered")
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.resultWait + 2) { [weak self] in
                self?.reallyStop()
                whenIdle?()
            }
            return false
        }
        reallyStop()
        return true
    }

    private func reallyStop() {
        changeAnswered(false)
        finished = true
        stopping = false
        armed = false
        resultTimer?.invalidate(); resultTimer = nil
        handshakeTimer?.invalidate(); handshakeTimer = nil
        if let m = manager {
            if m.state == .poweredOn { m.stopAdvertising(); m.removeAllServices() }
            m.delegate = nil
        }
        manager = nil
        outChar = nil
        session = nil
        talkingTo = nil
        subscribed.removeAll()
        nearCentrals.removeAll()
        nearWho.removeAll()
        doorOwedTo.removeAll()
        doorRefusals.removeAll()
        doorSaid = ""
        queued.removeAll()
        added = false
    }

    private func advertise() {
        guard armed, !finished, let m = manager, m.state == .poweredOn else { return }
        if !added {
            let out = CBMutableCharacteristic(type: outId, properties: [.notify],
                                              value: nil, permissions: [.readable])
            let into = CBMutableCharacteristic(type: inId, properties: [.write],
                                               value: nil, permissions: [.writeable])
            let nearL = CBMutableCharacteristic(type: nearId("left"), properties: [.notify],
                                                value: nil, permissions: [.readable])
            let nearR = CBMutableCharacteristic(type: nearId("right"), properties: [.notify],
                                                value: nil, permissions: [.readable])
            let svc = CBMutableService(type: CBUUID(nsuuid: service), primary: true)
            svc.characteristics = [out, into, nearL, nearR]
            outChar = out
            nearChars = [nearL, nearR]
            m.add(svc)
            added = true
            return
        }
        if !m.isAdvertising {
            // The service and nothing else: no name, no amount, no code.
            m.startAdvertising([CBAdvertisementDataServiceUUIDsKey: [CBUUID(nsuuid: service)]])
        }
    }

    func peripheralManagerDidUpdateState(_ p: CBPeripheralManager) {
        if let bad = cbState(p.state) { onEvent(bad, nil); return }
        advertise()
    }

    func peripheralManager(_ p: CBPeripheralManager, didAdd service: CBService, error: Error?) {
        guard error == nil else {
            print("[tap] receive: the service would not go up —", error!.localizedDescription)
            return
        }
        advertise()
    }

    func peripheralManagerDidStartAdvertising(_ p: CBPeripheralManager, error: Error?) {
        if let error { print("[tap] receive: not advertising —", error.localizedDescription); return }
        onEvent(.searching, nil)
        print("[tap] receive: on the air as \(service.uuidString)")
    }

    /// A payer has connected and wants to hear from us. Nothing is said here:
    /// the payer speaks first, and its M1 arrives as a write.
    func peripheralManager(_ p: CBPeripheralManager, central: CBCentral,
                           didSubscribeTo characteristic: CBCharacteristic) {
        if characteristic.uuid == nearId("left") || characteristic.uuid == nearId("right") {
            // which door says which edge of THIS screen the payer wants the mark on
            let edge = characteristic.uuid == nearId("left") ? "left" : "right"
            nearCentrals[central.identifier] = edge
            nearWho[central.identifier] = central
            if let ch = characteristic as? CBMutableCharacteristic {
                _ = p.updateValue(doorByte, for: ch, onSubscribedCentrals: [central])
            }
            if !linked, talkingTo == nil { onEvent(.nearby, edge) }
            return
        }
        guard characteristic.uuid == outId, !linked else { return }
        /* One payer at a time. A second one arriving mid-handshake would have
         * its bytes spliced into the first's. */
        /* And nobody while the amount is still being typed: there is nothing
         * to pay, and a code on that screen means nothing. A current payer
         * holds off by itself; this is for one that does not know to. */
        guard !early else {
            print("[tap] receive: a payer tried to join on the amount screen; not yet")
            return
        }
        guard talkingTo == nil || talkingTo == central.identifier else {
            print("[tap] receive: another phone tried to join; ignored")
            return
        }
        talkingTo = central.identifier
        if !subscribed.contains(where: { $0.identifier == central.identifier }) { subscribed.append(central) }
        arriving = TapProtocol.Bytes()
        session = TapSession(role: .receiver, service: service)
        /* Off the air the moment a payer is really there.
         *
         * It used to wait for `.linked`, three messages later, which left a few
         * hundred milliseconds in which a second phone could still find this
         * one. A subscribe is the earliest moment this side can act on — a bare
         * GATT connection is invisible to a peripheral, CoreBluetooth reports
         * nothing until somebody subscribes — and it is also the right one: a
         * payer subscribes only after its own proximity verdict has passed, so
         * this is a phone that has been held against ours, not one that walked
         * past. If it leaves without finishing, `didUnsubscribeFrom` puts this
         * back on the air. */
        if let m = manager, m.isAdvertising { m.stopAdvertising() }
        onEvent(.connecting, nil)
        handshakeTimer?.invalidate()
        handshakeTimer = Timer.scheduledTimer(withTimeInterval: Self.handshakeWait, repeats: false) { [weak self] _ in
            guard let self, !self.linked, !self.finished, self.talkingTo == central.identifier,
                  self.arriving.buffer.isEmpty else { return }
            print("[tap] receive: that phone subscribed and said nothing for \(Int(Self.handshakeWait))s; back on the air")
            self.subscribed.removeAll { $0.identifier == central.identifier }
            self.talkingTo = nil
            self.session = nil
            self.linkedCentral = nil
            self.offerSent = false
            self.onEvent(.searching, nil)
            self.advertise()
        }
    }

    func peripheralManager(_ p: CBPeripheralManager, central: CBCentral,
                           didUnsubscribeFrom characteristic: CBCharacteristic) {
        if characteristic.uuid == nearId("left") || characteristic.uuid == nearId("right") {
            let edge = characteristic.uuid == nearId("left") ? "left" : "right"
            // a payer changing doors (it has just learnt this phone's model) is not one leaving
            if nearCentrals[central.identifier] == edge {
                nearCentrals[central.identifier] = nil
                doorOwedTo.remove(central.identifier)
                doorRefusals[central.identifier] = nil
            }
            if nearCentrals.isEmpty { onEvent(.far, nil) }
            return
        }
        subscribed.removeAll { $0.identifier == central.identifier }
        guard central.identifier == talkingTo else { return }
        if busy {
            /* A payer that leaves with a payment half-written. Nothing is
             * answered — the page may still redeem what arrived — but the link
             * is gone, so there is nobody to tell. */
            print("[tap] receive: the payer went away with a payment in flight")
            if !resultSent { onEvent(.gone, nil) }
            /* And nothing more can come over a link that is gone. A payment the
             * page already has is the page's to finish, and `sealResult` ends
             * the wait when it answers. Anything short of that — a person being
             * asked, half a message — was waiting on the phone that just left,
             * and holding it kept this one off the air saying "that payment is
             * still going through" for as long as the asking clock had left to
             * run: twelve seconds of presses. */
            if !paymentHeard {
                resultTimer?.invalidate(); resultTimer = nil
                arriving = TapProtocol.Bytes()
            }
            /* Nor can change. It is held for so the link outlives the teardown
             * until the payer says it kept it (M8) — and a payer that has gone
             * will never say so over this link. It took the change and left
             * 170 ms later, and this phone refused the next customer for
             * twenty-seven seconds, "that payment is still going through".
             * What was sent is written on the payment's entry, where it can be shown
             * as a code if it never arrived. */
            if changeOwed && !changeTaken {
                changeOwed = false
                print("[tap] receive: the payer has gone, so the change is no longer waited for")
                changeAnswered(false)
            }
            return
        }
        guard !linked else {
            /* Linked, nothing in flight, and no result ever sent: said to the
             * page, which had no way to know the other phone had left and went
             * on showing a screen that was waiting for it. */
            if !resultSent {
                print("[tap] receive: the payer went away after the link was made")
                onEvent(.gone, nil)
            }
            return
        }
        /* Back on the air. This side went quiet at the subscribe, so a payer
         * that connects and then thinks better of it must not leave the screen
         * advertising nothing — the person is still holding a code up. */
        print("[tap] receive: that phone went away before the handshake finished")
        talkingTo = nil
        session = nil
        linkedCentral = nil
        offerSent = false
        advertise()
    }

    func peripheralManager(_ p: CBPeripheralManager, didReceiveWrite requests: [CBATTRequest]) {
        guard let first = requests.first else { return }
        guard first.characteristic.uuid == inId, first.central.identifier == talkingTo else {
            // said, so a word from a payer this phone no longer counts as its own is in the diary
            print("[tap] receive: a write from \(first.central.identifier == talkingTo ? "the payer on another characteristic" : "a central that is not the payer"); refused")
            p.respond(to: first, withResult: .insufficientAuthorization)
            return
        }
        p.respond(to: first, withResult: .success)
        for r in requests {
            guard let piece = r.value, let made = session else {
                if session == nil { print("[tap] receive: a write arrived with no session to read it") }
                continue
            }
            switch arriving.add(piece) {
            case .more:
                /* How far a large payment has got, for the screen. Only for
                 * one that will take a moment: a 4 KB payment is across in a
                 * second and a percentage would only flash. */
                if let got = arriving.progress, TapSession.carriesPayment(got.kind),
                   got.want > 6000 || expecting > 0 {
                    let total = expecting > 0 ? expecting : got.want
                    if let pct = arrivedSaid.step(done: arrivedBefore + got.have, of: total, cap: 99) {
                        onEvent(.receiving, String(pct))
                    }
                }
                continue
            case .bad:
                arriving = TapProtocol.Bytes()
                made.stopped("a message that would not read")
            case .done(let body):
                arriving = TapProtocol.Bytes()
                // a part that is in counts towards the whole; anything else ends the count
                if TapSession.carriesPayment(body.first), expecting > 0 { arrivedBefore += body.count + 2 }
                switch made.received(body) {
                case .paymentSize(let bytes):
                    expecting = bytes
                    arrivedBefore = 0
                    arrivedSaid = TapProgress()
                    print("[tap] receive: a payment of \(bytes) bytes is on its way")
                case .send(let out): push(out, to: r.central)
                case .linked(let code):
                    // already off the air, from the subscribe
                    handshakeTimer?.invalidate(); handshakeTimer = nil
                    linked = true
                    linkedCentral = r.central
                    onEvent(.code, code)
                    // and the offer, now or as soon as the page has one
                    sendOfferIfReady()
                case .payment(let text):
                    /* Asked of the payment, not of the clock. This read
                     * `resultTimer == nil`, which was the same question while
                     * only a payment could start the clock. M9 starts it too,
                     * and since every held decision sends one, a receiver that
                     * had agreed a price was holding a running clock when the
                     * money came — so the payment was dropped here without a
                     * word, the page never heard of it, and the payer waited
                     * forty seconds for an answer nobody was writing. */
                    guard !resultSent, !paymentHeard else { break }
                    paymentHeard = true
                    expecting = 0; arrivedBefore = 0; arrivedSaid = TapProgress()
                    // the page's word drives M6; nothing is sealed until it comes
                    resultTimer?.invalidate()
                    resultTimer = Timer.scheduledTimer(withTimeInterval: Self.resultWait,
                                                       repeats: false) { [weak self] _ in
                        self?.sealResult(504, "Their wallet did not answer in time.")
                    }
                    onPaid(text) { [weak self] status, why in
                        DispatchQueue.main.async { self?.sealResult(status, why) }
                    }
                case .again(let from):
                    let frames = made.framesSince(from)
                    print("[tap] receive: the payer was away; saying \(frames.count) message(s) again")
                    for f in frames { push(f, to: first.central) }
                case .changeTaken:
                    /* The payer's page has written the change down, so this side
                     * is finished with it. Until this arrives the receiver stays
                     * `busy` and will not let the link go — change is money going
                     * out, and bytes leaving says nothing about money kept. */
                    changeOwed = false
                    changeTaken = true
                    print("[tap] receive: the payer kept the change")
                    changeAnswered(true)
                case .stop(let why):
                    made.stopped(why)
                    session = nil
                    talkingTo = nil
                    linked = false
                    linkedCentral = nil
                    offerSent = false
                    advertise()
                /* A receiver never hears change, a result or an asking — it is
                 * the one that sends all three — so these are the payer's half of
                 * the conversation arriving at the wrong door, and nothing to act
                 * on. */
                case .quote(let text):
                    /* The payer's price, before any money. The page decides — it
                     * is a person looking at two numbers — and answers with
                     * `sendTerms` or by letting the link go. */
                    print("[tap] receive: a word from the payer arrived (a price, a question, or paid), handing it to the page")
                    onQuote(text)
                case .waiting, .offer, .result, .change, .asking, .terms:
                    break
                }
            }
        }
    }

    /// What became of the payment, sealed and handed back as M6. Said once: the
    /// page's answer and the give-up clock race, and only one may write.
    private func sealResult(_ code: Int, _ why: String) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard !resultSent else { return }
        /* The clock stops whether or not there is anybody left to tell. A payer
         * that had gone left the fired timer standing, and `busy` reads the
         * timer — so this phone refused to go back on the air, "that payment is
         * still going through", for as long as the stop's own fuse took to burn. */
        resultTimer?.invalidate(); resultTimer = nil
        guard let made = session, let who = talkingTo,
              let central = subscribed.first(where: { $0.identifier == who }) else {
            resultSent = true
            print("[tap] receive: the page answered \(code) and the payer has gone; nobody to tell")
            return
        }
        resultSent = true
        /* Clamped, because `pad` returns nil for anything that does not fit and
         * a nil M6 is a payer left waiting. */
        let short = String(why.prefix(160))
        let ok = code == 200
        let fields: [String: Any] = ok ? ["v": 2, "ok": true, "code": 200]
            : ["v": 2, "ok": false, "code": code, "why": short]
        let json = (try? JSONSerialization.data(withJSONObject: fields))
            .flatMap { String(data: $0, encoding: .utf8) }
            ?? "{\"v\":2,\"ok\":\(ok),\"code\":\(code)}"
        // and a bare one if even that would not seal, so M6 is never silence
        guard let sealed = made.sealResult(json)
                ?? made.sealResult("{\"v\":2,\"ok\":\(ok),\"code\":\(code)}") else {
            print("[tap] receive: the result would not seal; the payer will time out")
            return
        }
        print("[tap] receive: the page answered \(code); telling the payer")
        push(sealed, to: central)
        /* A stop that was waiting on this can have its way now — after a beat,
         * so the pieces of the answer are on the wire before the link goes.
         *
         * Unless change is still owed. M6 is no longer the end of the conversation
         * when there is change to hand back, and a teardown two seconds after it
         * would cut the change leg off at the knees. `busy` covers the wait; this
         * only has to not pre-empt it. */
        if stopping && !(changeOwed && !changeTaken) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self = self, !(self.changeOwed && !self.changeTaken) else { return }
                self.reallyStop()
            }
        }
    }

    private func push(_ message: Data, to central: CBCentral) {
        let frame = framed(message)
        let size = max(20, central.maximumUpdateValueLength)
        var i = 0
        while i < frame.count {
            queued.append((central, frame.subdata(in: i..<min(i + size, frame.count))))
            i += size
        }
        pump()
    }

    private func pump() {
        guard let m = manager, let ch = outChar else { return }
        while let (central, piece) = queued.first {
            guard m.updateValue(piece, for: ch, onSubscribedCentrals: [central]) else { return }
            queued.removeFirst()
        }
    }

    func peripheralManagerIsReady(toUpdateSubscribers p: CBPeripheralManager) {
        pump()
        if !doorOwedTo.isEmpty { tellTurned(only: doorOwedTo) }
    }

    func peripheralManager(_ p: CBPeripheralManager, didReceiveRead request: CBATTRequest) {
        p.respond(to: request, withResult: .readNotPermitted)
    }
}


/// The paying phone, which never advertises.
///
/// It is not silent: iOS scans actively, so this phone sends scan requests as
/// any scanning iPhone does. What it never does is put a service on the air,
/// which is the part that would say who and where its user is. A customer
/// carrying Foxy through a room full of merchants gives away nothing they could
/// be followed by.
///
/// It listens from the home and send screens, so paying needs no screen of its
/// own: the merchant presses TAP, this phone hears it, and the confirmation
/// comes up. Listening stops when Foxy leaves the foreground — there are no
/// background modes, and there is nothing here worth asking for one.
///
/// Choosing also lands on the right phone. A central picks who to talk to by
/// signal strength; a peripheral cannot, because CoreBluetooth gives it no
/// reading for whoever connected. The person holding the phone that is about to
/// spend is the one now doing the choosing.
///
/// Main queue only.
final class TapPayer: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate {

    private let onStage: (TapStage) -> Void
    /// When a receiver within `nearbyDbm` was last reported to the page.
    private var lastNearby: TimeInterval = 0
    /// The offer, once it is in: the payload and the four digits.
    private let done: (String, String) -> Void
    /* What to do with change, and how the page says it has it.
     *
     * Two arguments, like `onPaid` on the other side: the token, and a closure the
     * page calls once the change is written down. Money going the other way needs
     * the same discipline money coming in has — the ack is the page's word, not
     * the radio's. Defaulted to "nothing arrived, nothing kept" so a caller that
     * has no use for change is unchanged. */
    private let onChange: (String, @escaping (Bool) -> Void) -> Void
    /* M11, at the payer: the receiver agreed the price and sent the request, now
     * in sats. Defaulted to doing nothing, so a caller with no price leg is
     * unchanged. */
    private let onTerms: (String) -> Void
    private var manager: CBCentralManager?
    private var proximity = TapProximity()

    /* Where the seconds between "a receiver is there" and "the code is up" go.
     *
     * Nothing in the log used to say which of connecting, discovery or
     * subscribing a slow tap had spent its time in. */
    private var linkBegan: TimeInterval = 0
    private var stamps: [String] = []
    private func stamp(_ what: String) {
        guard linkBegan > 0 else { return }
        let ms = Int((ProcessInfo.processInfo.systemUptime - linkBegan) * 1000)
        stamps.append("\(what) \(ms)ms")
    }

    private var seen: [UUID: (peripheral: CBPeripheral, service: CBUUID)] = [:]
    private var skip: [UUID: Date] = [:]
    /// Nothing is looked at for a few seconds after a receiver has answered a
    /// payment: the person is reading their confirmation, and the phone in
    /// their hand is still against the one they paid.
    private var quietUntil = Date.distantPast
    private var target: CBPeripheral?
    private var service: UUID?
    private var session: TapSession?
    private var incoming = TapProtocol.Bytes()
    private var tick: Timer?
    private var giveUp: Timer?
    /* A person is reading a card on the other phone (M9), so the payer's own
     * thirty seconds are the wrong clock. Ninety matches the receiver's
     * `askingWait`, plus nothing: whichever fires first ends it, and the
     * receiver's own timer answers M6 rather than leaving silence. */
    static let personWait: TimeInterval = 95
    private var waitingOnPerson = false

    /* The link opened before the verdict, and whether its doors are found.
     *
     * The receiver cannot know a payer is there until it is subscribed to, and
     * subscribing is the far end of connecting plus two rounds of discovery —
     * 1.3 s in testing. So the link is opened as soon as a receiver
     * is plausibly near (`warmest`) and nothing is said down it; the verdict
     * then costs one round trip instead of four.
     *
     * Warm is silent. A phone linked to and not paid gets no callback, no
     * message and no offer — CoreBluetooth tells a peripheral nothing until it
     * is subscribed to — and the link closes behind it. That is what makes it
     * acceptable to do this while merely walking past somebody. */
    private var warmReady = false
    private var nearNow = false

    /* Once a link is open, iOS stops handing this scan that peripheral's
     * advertisements — and those advertisements were the only readings the
     * verdict had. Warming therefore starved the thing it was meant to run
     * underneath: the other phone sat at -50 dBm, well inside -52, and the
     * readings aged out of the one-second memory before three of them could
     * agree, so the verdict never came and the tap never happened.
     *
     * A connected central can ask instead. `readRSSI` is the same measurement
     * over the open link, and a steadier one — no advertising interval to wait
     * on. One question at a time, because the answers arrive on the delegate
     * and a queue of them says nothing new. */
    private var asking = false
    private var warmSince: TimeInterval = 0
    private var warmReadings = 0

    /* Warming off for the rest of this listen.
     *
     * If the open link will not answer with a signal strength, the verdict has
     * nothing to go on and no tap can ever happen — which is worse than the
     * second and a half warming was meant to save. So a warm link that says
     * nothing for two seconds is dropped, warming stops, and this falls back to
     * deciding on advertisements exactly as it did before. Slower, and it
     * works. */
    private var warmOff = false
    private var lastLog: TimeInterval = 0
    private var lastLogDbm = 0
    private var lastLogWhy = ""
    private var linked = false
    private var finished = false
    private var spoke = false
    private var passedBy = 0
    private var notFoxy = 0

    init(onStage: @escaping (TapStage) -> Void,
         onChange: @escaping (String, @escaping (Bool) -> Void) -> Void = { _, keep in keep(false) },
         onTerms: @escaping (String) -> Void = { _ in },
         done: @escaping (String, String) -> Void) {
        self.onStage = onStage
        self.done = done
        self.onChange = onChange
        self.onTerms = onTerms
        super.init()
    }

    /// M10: this phone's price, and what it makes of the dollar amount asked
    /// for. Sent before anything is paid.
    func sendQuote(_ text: String) -> Bool {
        guard linked, let made = session, let p = target, p.state == .connected,
              let sealed = made.sealQuote(text) else { return false }
        write(sealed, to: p)
        // M10 carries a price, the question asked before a payment, or the word that an invoice is paid
        print("[tap] pay: sent the receiver a word on the link (a price, a question, or paid)")
        return true
    }

    /* M8, once the page has the change written down — or says it has not.
     *
     * A refusal is sent too, rather than silence: the receiver is holding the link
     * open waiting, and "we could not keep it" is an answer it can act on where
     * nothing at all is only a timeout. */
    private func ackChange(_ kept: Bool) {
        guard kept, !finished, let made = session, let p = target,
              let sealed = made.sealChangeTaken() else {
            if !kept { print("[tap] pay: the page could not keep the change") }
            return
        }
        print("[tap] pay: change written down; telling the receiver")
        ackOut = true
        write(sealed, to: p)
    }
    /// The word that the change was kept (M8) is being written; `stop` waits for it.
    private var ackOut = false
    /// `stop` was asked for while a write was still going out: the link closes once it has.
    private var closingAfterWrites = false

    func start() {
        manager = CBCentralManager(delegate: self, queue: .main,
                                   options: [CBCentralManagerOptionShowPowerAlertKey: false])
    }

    func stop() {
        /* Not with a word half-written. The page lets the link go the moment
         * its change is written down, and the word that it was kept (M8) was
         * still in the write queue when the link was cut: the receiver, put
         * away mid-handover, never heard it and showed the change as owed.
         * Two seconds at most. */
        if (writing || !outgoing.isEmpty), let t = target, t.state == .connected, !closingAfterWrites {
            closingAfterWrites = true
            print("[tap] pay: a word is still going out; the link closes once it has")
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self, self.closingAfterWrites else { return }
                print("[tap] pay: the word did not finish going out in 2s; closing anyway")
                self.closingAfterWrites = false
                self.stop()
            }
            return
        }
        closingAfterWrites = false
        finished = true
        tick?.invalidate(); tick = nil
        giveUp?.invalidate(); giveUp = nil
        if passedBy > 0 || notFoxy > 0 {
            print("[tap] pay: the filter passed by \(passedBy) advertisement(s) and dropped \(notFoxy) that were not Foxy")
        }
        if let m = manager {
            if m.state == .poweredOn { m.stopScan() }
            if let t = target { m.cancelPeripheralConnection(t) }
            m.delegate = nil
        }
        manager = nil
        target = nil
        session = nil
        if sendDone != nil { finishSend(.lost("Nobody is connected any more.")) }
    }

    private func scan() {
        guard let m = manager, m.state == .poweredOn, !finished else { return }
        proximity.forget()
        seen = [:]
        target = nil
        announced = nil
        theirTurned = false
        theirEarly = false
        heardDoor = false
        nearSince = 0
        service = nil
        session = nil
        warmReady = false
        nearNow = false
        asking = false
        spoke = false
        warmSince = 0
        warmReadings = 0
        incoming = TapProtocol.Bytes()
        // everything, because a receiver's UUID is new every time
        m.scanForPeripherals(withServices: nil,
                             options: [CBCentralManagerScanOptionAllowDuplicatesKey: true])
        tick?.invalidate()
        tick = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in self?.judge() }
    }

    func centralManagerDidUpdateState(_ c: CBCentralManager) {
        if let bad = cbState(c.state) { onStage(bad); return }
        scan()
    }

    /// The shape an iOS app's advertisement has, and nothing else's. A Watch,
    /// AirPods and everything doing Apple's Continuity carry manufacturer data.
    func centralManager(_ c: CBCentralManager, didDiscover p: CBPeripheral,
                        advertisementData d: [String: Any], rssi RSSI: NSNumber) {
        /* Advertisements keep being recorded once a link is warm.
         *
         * This used to return the moment `target` was set, which meant opening
         * a warm link stopped the advertisement pool being fed at all — it aged
         * out two seconds later and from then on only the link's own readings
         * existed. That was survivable while the link could decide alone. It
         * stopped being survivable when the link was made to agree with the
         * last advertisement: the last advertisement was then
         * always the far one that triggered the warming, so a phone held
         * against another was refused over and over and the person pressed TAP
         * again and again with nothing happening.
         *
         * Recording costs nothing and changes no choice: `warm()` still only
         * opens one link, and `judge()` still compares against the target it
         * already has. What it buys is the verdict being taken on the scale it
         * was calibrated on, for as long as iOS keeps handing them over. */
        if quietUntil > Date() { return }
        if let until = skip[p.identifier], until > Date() { return }
        guard (d[CBAdvertisementDataIsConnectable] as? Bool) == true,
              d[CBAdvertisementDataManufacturerDataKey] == nil,
              let ids = d[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID],
              ids.count == 1, ids[0].data.count == 16 else {
            passedBy += 1
            return
        }
        seen[p.identifier] = (p, ids[0])
        proximity.add(p.identifier, dbm: RSSI.intValue, at: ProcessInfo.processInfo.systemUptime)
    }

    /// The door the receiver has been told on ("left" or "right"), or nil.
    private var announced: String?
    /// When a receiver first read near enough for the card, this time round.
    private var nearSince: TimeInterval = 0
    /// The receiver's model, from iOS's own Device Information service, which
    /// every iPhone serves to any connection. Empty until it has been read.
    ///
    /// Remembered by peripheral for as long as Foxy runs. Reading it is the
    /// last of four round trips on a fresh link — about a second and a half
    /// after the receiver goes on the air — and both CONNECT TO PAY cards wait
    /// for it. A receiver seen before is the same phone behind a new service
    /// number, so the second invoice from it has the cards up as soon as the
    /// link is warm.
    private static var models: [UUID: String] = [:]
    private var theirModel: String { target.flatMap { Self.models[$0.identifier] } ?? "" }
    static let deviceInformation = CBUUID(string: "180A")
    static let modelNumber = CBUUID(string: "2A24")

    /// Which edge of this phone, and of theirs, to hold together (TapEdges).
    private var edges: (payer: String, receiver: String) {
        TapEdges.edges(payer: TapEdges.thisModel, receiver: theirModel)
    }
    /// The edge this phone's own CONNECT TO PAY card puts its mark on.
    var edge: String {
        let e = edges.payer
        return theirTurned ? (e == "left" ? "right" : "left") : e
    }
    /// The receiver said it is top-down (a byte on the near door).
    private var theirTurned = false
    /// The receiver is still on its amount screen: no card here until it is not.
    private var theirEarly = false
    /// The near door has said something; until then the card waits (1.5 s at most).
    private var heardDoor = false
    private var announcedAt: TimeInterval = 0

    /// Say "near" or "not near" to the receiver, over the warm link and on a
    /// near door only. Nothing else crosses: no key, no handshake. It is what
    /// puts CONNECT TO PAY on their screen while it is on this one, and the
    /// door chosen is which edge of their screen the mark goes on. A receiver
    /// from before the near doors simply has none, and nothing is said.
    private func announce(_ on: Bool) {
        let want: String? = on ? edges.receiver : nil
        guard want != announced, warmReady, let s = service, let p = target, p.state == .connected,
              let svc = p.services?.first(where: { $0.uuid == CBUUID(nsuuid: s) }) else { return }
        let door = { (e: String) in svc.characteristics?.first(where: {
            $0.uuid == CBUUID(nsuuid: TapCrypto.nearCharacteristic(for: s, edge: e)) }) }
        // the new door first, so the receiver never sees nobody near in between
        if let e = want, let ch = door(e) { p.setNotifyValue(true, for: ch) }
        if let was = announced, let ch = door(was) { p.setNotifyValue(false, for: ch) }
        announced = want
        if want != nil { announcedAt = ProcessInfo.processInfo.systemUptime }
    }

    /// TAP TO PAY was pressed on the payer's screen: the receiver it is
    /// showing the toast for is taken, without the phones touching. A press
    /// is a decision, which is what the -40 cut-off stands in for when nobody
    /// has made one — and the four digits and the amount are still to come.
    /// For a few seconds only, then touching is the rule again.
    func connectNearby() {
        let touching = proximity.nearDbm
        /* Eight below the toast's own line, not on it. The toast goes up on
         * a reading at -48 and stays for a couple of seconds, and the signal
         * between two phones a hand apart wanders several dB either side: the
         * first press landed while it read -49 to -52 and did nothing at all.
         * What the person pressed is the
         * receiver the toast was up for, so that receiver is taken. */
        let pressed = proximity.nearbyDbm - 8
        guard touching > pressed, !linked, !finished else { return }
        print("[tap] pay: TAP TO PAY pressed; taking a receiver from \(pressed) dBm")
        proximity.nearDbm = pressed
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.proximity.nearDbm = touching
        }
        judge()
    }

    private func judge() {
        guard !finished, !nearNow else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let warm = target {
            /* The readings for this one now come over the link. */
            // only once it is really connected: readRSSI on a link still being
            // opened never answers, and the flag would never clear
            if !asking, warm.state == .connected { asking = true; warm.readRSSI() }
            /* And a link that never becomes a tap is let go, so a receiver who
             * arrives behind it can be warmed in its place. */
            if warmSince > 0, warmReadings == 0, now - warmSince > 2 {
                warmOff = true
                print("[tap] pay: the open link will not say how strong it is; "
                      + "deciding on advertisements instead")
                retry("the link would not answer")
                return
            }
            /* Not while the receiver has been told this phone is near. The
             * "near" it was told lives on this link: letting the link go and
             * opening another a second later took their CONNECT TO PAY card
             * down and put it back, every twenty seconds, for as long as the
             * two phones sat beside each other (a warm link dropped and
             * reopened on the 20 s mark, ten times in one log). A link that is doing that job has not come to nothing. */
            if warmSince > 0, now - warmSince > 20, announced == nil {
                print("[tap] pay: a warm link came to nothing; letting it go")
                retry("warm too long")
                return
            }
        }
        switch proximity.verdict(at: now) {
        case .nothing: warm(at: now)
        case .far(let dbm):
            /* Said when it changes, not twice a second. This one line was a
             * sixth of everything a phone wrote (4,160 of 24,236 lines in one
             * log), and the log a tester can share holds
             * 2,500 lines: a receiver left nearby pushed the payment that went
             * wrong out of it in twenty minutes. Four decibels, a new reason,
             * or ten seconds — whichever comes first. */
            let why = proximity.why
            if now - lastLog > 0.5, abs(dbm - lastLogDbm) >= 4 || why != lastLogWhy || now - lastLog > 10 {
                lastLog = now
                lastLogDbm = dbm
                lastLogWhy = why
                print("[tap] pay: something at \(dbm) dBm, not close enough (\(why))")
            }
            /* Near enough to be told about: the page shows TAP TO PAY. Said
             * every second or so while it lasts, and `far` once it stops, so
             * the page can take the toast down. */
            if dbm >= proximity.nearbyDbm {
                /* Both screens together. This phone knew a receiver was near
                 * the moment it heard it; the receiver only knows once the
                 * warm link is up and a near door is subscribed, a second or
                 * so later — so the payer's card was up alone, pointing at a
                 * phone that showed nothing. The card
                 * here waits for the announcement to have gone, and for no
                 * longer than a second and a half: a receiver with no near
                 * door, or a link that will not warm, still gets the card. */
                if nearSince == 0 { nearSince = now }
                /* And neither card until the other phone's model is read, for
                 * the same second and a half at most: the edge depends on the
                 * pair, and a card that goes up on the default edge and then
                 * jumps to the other side is worse than one a moment later. */
                let waited = now - nearSince > 1.5
                if !theirModel.isEmpty || waited { announce(true) }
                /* The card waits for the receiver's own word that it is on its
                 * invoice screen. The second and a half ran out before the
                 * link was warm, so the card went up and came straight down
                 * again for a receiver still typing an amount. A receiver that
                 * says nothing gets a
                 * second after the announcement; one with no link at all, four. */
                let ready = announced != nil
                    ? (heardDoor || now - announcedAt > 1.0)
                    : now - nearSince > 4
                if ready, !theirEarly, now - lastNearby > 1.0 {
                    lastNearby = now
                    onStage(.nearby)
                }
            } else if lastNearby > 0, now - lastNearby > 2.5 {
                lastNearby = 0
                nearSince = 0
                onStage(.far)
                announce(false)
            } else if lastNearby == 0 {
                nearSince = 0
            }
            warm(at: now)
        case .near(let id, let dbm):
            guard let found = seen[id], let m = manager else { return }
            /* Not while the receiver is still typing an amount. Its link is
             * warm from the amount screen on purpose, and a phone held against
             * it shook hands there: a code on a screen with nothing to pay,
             * and a payer left on "connecting". The receiver's own word is
             * waited for — a second at most when it says nothing, as an older Foxy does. */
            /* And so the quiet link comes first, always. A phone already
             * touching when the receiver went on the air was taken "the long
             * way" — connect, then speak — with no moment to ask (one payer
             * shook hands 1.9 s after the receiver opened its amount screen).
             * The long way took as long as warming does, so
             * nothing is lost by asking first. Not when warm links are off. */
            if !warmOff, target !== found.peripheral || !warmReady {
                if target !== found.peripheral {
                    if let old = target { m.cancelPeripheralConnection(old) }
                    announced = nil; heardDoor = false; theirEarly = false; theirTurned = false
                    target = found.peripheral
                    service = UUID(uuidString: found.service.uuidString)
                    warmReady = false
                    warmSince = now
                    warmReadings = 0
                    found.peripheral.delegate = self
                    m.connect(found.peripheral)
                }
                return
            }
            if target === found.peripheral, warmReady {
                if announced == nil { announce(true) }
                let unheard = announced != nil && !heardDoor && now - announcedAt < 1.0
                if theirEarly || unheard {
                    if now - lastLog > 1.0 {
                        lastLog = now
                        print("[tap] pay: touching at \(dbm) dBm, but that phone "
                              + (theirEarly ? "is still on its amount screen; waiting for NEXT"
                                            : "has not said which screen it is on yet"))
                    }
                    return
                }
            }
            print("[tap] pay: a receiver at \(dbm) dBm (needs \(proximity.lastThreshold)"
                  + (proximity.decidedOnLink ? ", over the link" : ", advertised")
                  + "), \(target === found.peripheral ? "already linked" : "connecting")")
            onStage(.connecting)
            nearNow = true
            linkBegan = now
            stamps = []
            m.stopScan()
            tick?.invalidate(); tick = nil
            giveUp?.invalidate()
            giveUp = Timer.scheduledTimer(withTimeInterval: 8, repeats: false) { [weak self] _ in
                self?.retry("timed out")
            }
            // the phone the warm link already belongs to: one round trip to go
            if target === found.peripheral {
                if warmReady { speak() }
                return
            }
            // somebody else's link was warm; drop it and open this one the long way
            if let old = target { m.cancelPeripheralConnection(old) }
            warmReady = false
            target = found.peripheral
            service = UUID(uuidString: found.service.uuidString)
            found.peripheral.delegate = self
            m.connect(found.peripheral)
        }
    }

    /// Open a link to the likeliest receiver before the verdict, and say
    /// nothing down it. The scan keeps running — the readings that decide the
    /// verdict are advertisements, and they stop arriving if it does not.
    private func warm(at now: TimeInterval) {
        guard !warmOff, target == nil, let m = manager,
              let id = proximity.warmest(at: now), let found = seen[id] else { return }
        target = found.peripheral
        service = UUID(uuidString: found.service.uuidString)
        warmReady = false
        warmSince = now
        warmReadings = 0
        found.peripheral.delegate = self
        m.connect(found.peripheral)
    }

    /// Subscribe, which is the first thing the receiver can hear — and then
    /// speak, because the payer speaks first. Everything before this is this
    /// phone's business alone.
    private func speak() {
        guard let s = service, let p = target,
              let svc = p.services?.first(where: { $0.uuid == CBUUID(nsuuid: s) }),
              let out = svc.characteristics?.first(where: { $0.uuid == CBUUID(nsuuid: TapCrypto.outCharacteristic(for: s)) })
        else { retry("the doors went away"); return }
        session = TapSession(role: .payer, service: s)
        stamp("doors")
        p.setNotifyValue(true, for: out)
    }

    private func retry(_ why: String) {
        guard !finished, !linked else { return }
        /* Quiet when nothing had been said. A warm link that comes to nothing
         * is this phone's business: no screen changed for it, so no screen
         * should change back. */
        if nearNow {
            print("[tap] pay: gave up on that one (\(why)); looking again")
            // said as `gone` first, which the page's connecting screen does not sit through
            onStage(.gone)
            onStage(.searching)
        }
        giveUp?.invalidate(); giveUp = nil
        if let t = target {
            /* Only a phone that is not a Foxy is left alone for a while. A
             * Foxy whose doors went away is one that re-armed — a new invoice
             * screen, a new service on the same peripheral — and skipping it
             * was ten seconds of nothing until the app was backgrounded and
             * brought back. */
            if nearNow, why.hasPrefix("not a Foxy") || why.hasPrefix("the doors are not Foxy") {
                skip[t.identifier] = Date().addingTimeInterval(10)
            }
            manager?.cancelPeripheralConnection(t)
        }
        target = nil
        announced = nil
        theirTurned = false
        theirEarly = false
        heardDoor = false
        nearSince = 0
        warmReady = false
        nearNow = false
        asking = false
        spoke = false
        warmSince = 0
        warmReadings = 0
        outgoing.removeAll()
        writing = false
        scan()
    }

    func centralManager(_ c: CBCentralManager, didConnect p: CBPeripheral) {
        guard let s = service else { retry("no service"); return }
        stamp("connected")
        p.discoverServices([CBUUID(nsuuid: s), Self.deviceInformation])
    }

    func centralManager(_ c: CBCentralManager, didFailToConnect p: CBPeripheral, error: Error?) {
        retry("could not connect")
    }

    func centralManager(_ c: CBCentralManager, didDisconnectPeripheral p: CBPeripheral, error: Error?) {
        guard p === target else { return }
        /* A receiver that goes mid-payment, said now rather than waited out.
         * Nothing was confirmed, so this is a lost link: the payment falls back
         * to the request's own transport. */
        if sendDone != nil {
            finishSend(.lost("That phone went away before it said what became of the payment."))
            return
        }
        // a warm link closing is not news; only one that had been spoken down
        if nearNow { print("[tap] pay: the link closed", error.map { "— \($0.localizedDescription)" } ?? "") }
        if !finished, !linked { retry("disconnected") }
    }

    /* The receiver left its screen. Its link stays open — a peripheral cannot
     * close one — and goes on answering how strong it is, so the card here
     * stayed up for a phone that was no longer asking for anything: for seconds,
     * and for good once "near" had been said and the warm link was
     * being kept for it. The service going is the news. */
    func peripheral(_ p: CBPeripheral, didModifyServices gone: [CBService]) {
        guard p === target, !finished, !linked, !nearNow, let s = service,
              gone.contains(where: { $0.uuid == CBUUID(nsuuid: s) }) else { return }
        print("[tap] pay: the receiver went off the air; the card comes down")
        if lastNearby > 0 { lastNearby = 0; onStage(.far) }
        retry("the receiver went off the air")
    }

    func peripheral(_ p: CBPeripheral, didReadRSSI RSSI: NSNumber, error: Error?) {
        asking = false
        guard p === target, !finished, !nearNow, error == nil else { return }
        if warmReadings == 0 {
            /* Said once, because the threshold was measured on advertisements
             * and these are connection events. If the two scales differ the
             * number has to move again, and this is the line that will say so.
             *
             * It has to move at least once anyway: -52 was measured with the
             * *receiver* doing the measuring, and this side is not that side.
             * Flipping who measures moved it from -44 to -52 the last time,
             * so treat -52 as a starting point, not a result. */
            let heard = proximity.lastHeard(p.identifier)
            print("[tap] pay: the open link answers at \(RSSI.intValue) dBm"
                  + (heard.map { " (its advertisement said \($0))" } ?? ""))
        }
        warmReadings += 1
        // its own pool and its own threshold: the two scales are not a fixed
        // offset apart, and a median across both decided one tap by one reading
        proximity.addLinked(p.identifier, dbm: RSSI.intValue, at: ProcessInfo.processInfo.systemUptime)
    }

    func peripheral(_ p: CBPeripheral, didDiscoverServices error: Error?) {
        guard let s = service,
              let svc = p.services?.first(where: { $0.uuid == CBUUID(nsuuid: s) }) else {
            notFoxy += 1
            retry("not a Foxy")
            return
        }
        stamp("service")
        p.discoverCharacteristics([CBUUID(nsuuid: TapCrypto.inCharacteristic(for: s)),
                                   CBUUID(nsuuid: TapCrypto.outCharacteristic(for: s)),
                                   CBUUID(nsuuid: TapCrypto.nearCharacteristic(for: s, edge: "left")),
                                   CBUUID(nsuuid: TapCrypto.nearCharacteristic(for: s, edge: "right"))], for: svc)
        // and which iPhone it is, for the edge to hold against it (TapEdges)
        if let info = p.services?.first(where: { $0.uuid == Self.deviceInformation }) {
            p.discoverCharacteristics([Self.modelNumber], for: info)
        }
    }

    func peripheral(_ p: CBPeripheral, didDiscoverCharacteristicsFor svc: CBService, error: Error?) {
        if svc.uuid == Self.deviceInformation {
            if let model = svc.characteristics?.first(where: { $0.uuid == Self.modelNumber }) { p.readValue(for: model) }
            return
        }
        guard let s = service,
              svc.characteristics?.contains(where: { $0.uuid == CBUUID(nsuuid: TapCrypto.outCharacteristic(for: s)) }) == true,
              svc.characteristics?.contains(where: { $0.uuid == CBUUID(nsuuid: TapCrypto.inCharacteristic(for: s)) }) == true else {
            // the derived doors are what say this is a Foxy, not the shape
            notFoxy += 1
            retry("the doors are not Foxy's")
            return
        }
        warmReady = true
        stamp("doors found")
        // subscribing is what makes the receiver notice, and it waits for the
        // verdict: until then this phone has only opened a door, not knocked
        if nearNow { speak() }
    }

    /// The subscribe landed, so the receiver can hear us now — and the payer
    /// speaks first. This is where M1 goes out.
    func peripheral(_ p: CBPeripheral, didUpdateNotificationStateFor ch: CBCharacteristic, error: Error?) {
        guard let s = service, ch.uuid == CBUUID(nsuuid: TapCrypto.outCharacteristic(for: s)),
              ch.isNotifying, !spoke, let made = session else { return }
        if let error { retry("subscribing failed: \(error.localizedDescription)"); return }
        spoke = true
        stamp("subscribed")
        if case .send(let first) = made.begin() { write(first, to: p) }
    }

    func peripheral(_ p: CBPeripheral, didUpdateValueFor ch: CBCharacteristic, error: Error?) {
        if ch.uuid == Self.modelNumber {
            guard p === target, let data = ch.value, let text = String(data: data, encoding: .utf8) else { return }
            let model = String(text.filter { $0.isLetter || $0.isNumber || $0 == "," }.prefix(24))
            guard model != theirModel else { return }
            Self.models[p.identifier] = model
            print("[tap] pay: that phone is a \(model); this one's \(edges.payer) edge to its \(edges.receiver)")
            // a card already up, on either screen, is put on the right edge
            if announced != nil { announce(true) }
            if lastNearby > 0 { onStage(.nearby) }
            return
        }
        if let s = service, p === target,
           ch.uuid == CBUUID(nsuuid: TapCrypto.nearCharacteristic(for: s, edge: "left"))
            || ch.uuid == CBUUID(nsuuid: TapCrypto.nearCharacteristic(for: s, edge: "right")) {
            let byte = ch.value?.first ?? 0
            let now = byte & 1 == 1, isEarly = byte & 2 == 2
            heardDoor = true
            print("[tap] pay: the near door said \(byte)")
            if isEarly != theirEarly {
                theirEarly = isEarly
                print("[tap] pay: that phone is \(isEarly ? "still on its amount screen; no card yet" : "on its invoice screen")")
                if isEarly, lastNearby > 0 { lastNearby = 0; onStage(.far) }
            }
            if now != theirTurned {
                theirTurned = now
                print("[tap] pay: that phone is \(now ? "top-down" : "upright"); this one's mark goes \(edge)")
                if lastNearby > 0 { onStage(.nearby) }
            }
            return
        }
        guard let s = service, ch.uuid == CBUUID(nsuuid: TapCrypto.outCharacteristic(for: s)),
              let piece = ch.value, let made = session else { return }
        if !stamps.contains(where: { $0.hasPrefix("receiver spoke") }) {
            stamp("receiver spoke")
            print("[tap] pay: link: " + stamps.joined(separator: ", "))
            /* Longer, now that somebody is really there.
             *
             * Eight seconds is for "connected and nothing came of it". Once the
             * receiver has answered at all, the wait that remains is its page
             * getting an invoice or an onion address, which it may not have had
             * when the person pressed TAP — the offer is allowed to follow the
             * handshake (`offerSent`). Dropping the link at eight seconds would
             * throw away a tap that was working. */
            giveUp?.invalidate()
            giveUp = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
                self?.retry("nothing came after the handshake")
            }
        }
        switch incoming.add(piece) {
        case .more: return
        case .bad: retry("a message that would not read")
        case .done(let body):
            switch made.received(body) {
            case .send(let out): write(out, to: p)
            case .offer(let text, let code):
                /* The handshake is over and the link is held, not dropped: the
                 * payment goes back over this same link (`send`). Scanning
                 * stops — this phone has the receiver it came for. */
                linked = true
                giveUp?.invalidate(); giveUp = nil
                tick?.invalidate(); tick = nil
                manager?.stopScan()
                onStage(.linked)
                done(text, code)
            case .result(let what):
                print("[tap] pay: the receiver said \(what.prefix(60))")
                /* And that phone is left alone for a while. Its screen re-arms
                 * the moment it has answered — a cross-mint claim takes it
                 * seconds more to show as paid — and a payer back on home after
                 * dismissing its own confirmation connected to the same invoice
                 * again. */
                if let t = target { skip[t.identifier] = Date().addingTimeInterval(90) }
                quietUntil = Date().addingTimeInterval(5)
                finishSend(.answered(what))
            case .change(let text):
                /* Change, which is money: the page is given it and answers when it
                 * has written it down, and only then does M8 go back. The receiver
                 * holds the link open until it does. */
                print("[tap] pay: change arrived, handing it to the page")
                onChange(text) { [weak self] kept in
                    DispatchQueue.main.async { self?.ackChange(kept) }
                }
            case .asking:
                /* A person on the other phone is reading a card about this
                 * payment. The wait stretches and the screen says so: twenty
                 * seconds of nothing, in the middle of handing money over, reads
                 * as a broken app. Nothing else changes — M6 still decides. */
                /* Once, and only once. A second M9 would let the other side
                 * hold this link — and this phone's ecash, which is already
                 * swapped and locked to them — open for as long as it kept
                 * sending them. */
                guard !waitingOnPerson else {
                    print("[tap] pay: a second asking; ignored")
                    break
                }
                print("[tap] pay: they are asking a person; waiting")
                waitingOnPerson = true
                giveUp?.invalidate()
                giveUp = Timer.scheduledTimer(withTimeInterval: Self.personWait,
                                              repeats: false) { [weak self] _ in
                    self?.retry("they never came back from asking a person")
                }
                onStage(.asking)
            case .stop(let why):
                made.stopped(why)
                retry(why)
            case .terms(let text):
                /* They agreed the price and sent the request, now in sats. This
                 * is the offer the payment answers; nothing has left this phone
                 * yet, which is the point of the order. */
                print("[tap] pay: they agreed the price; the request is in")
                onTerms(text)
            case .waiting, .linked, .payment, .changeTaken, .quote, .again, .paymentSize:
                break
            }
        }
    }

    /* One write at a time, and the next only when the last is acknowledged.
     *
     * A `.withResponse` write is a round trip. Firing a message's pieces off in
     * a loop hands CoreBluetooth a queue it does not promise to keep, and the
     * far end gets some of them: the payment is 4096 bytes padded, about
     * twenty-three pieces, and the receiver's session never saw a single one —
     * no "a payment arrived, sealed" line at all — while the payer sat in the
     * bridge's timeout and then fell back to the onion.
     *
     * It is new with the roles. The handshake's messages are one piece each and
     * went through a loop quite happily; the only large message is the payment,
     * and until the roles were last swapped that travelled the other way — peripheral to central
     * as notifications, which `pump()` already paces against
     * `peripheralManagerIsReady`. This is that, for the direction the payment
     * takes now. */
    private var outgoing: [Data] = []
    private var writing = false

    private func write(_ message: Data, to p: CBPeripheral) {
        let frame = framed(message)
        let size = max(20, p.maximumWriteValueLength(for: .withResponse))
        var i = 0
        while i < frame.count {
            outgoing.append(frame.subdata(in: i..<min(i + size, frame.count)))
            i += size
        }
        pumpWrites(to: p)
    }

    private func pumpWrites(to p: CBPeripheral) {
        guard !writing, !outgoing.isEmpty, p.state == .connected,
              let s = service,
              let ch = p.services?.first(where: { $0.uuid == CBUUID(nsuuid: s) })?
                .characteristics?.first(where: { $0.uuid == CBUUID(nsuuid: TapCrypto.inCharacteristic(for: s)) })
        else { return }
        writing = true
        p.writeValue(outgoing.removeFirst(), for: ch, type: .withResponse)
    }

    func peripheral(_ p: CBPeripheral, didWriteValueFor ch: CBCharacteristic, error: Error?) {
        writing = false
        if let error {
            print("[tap] pay: a piece would not go —", error.localizedDescription)
            outgoing.removeAll()
            if ackOut { ackOut = false; print("[tap] pay: the word that the change was kept did not get through") }
            /* The payment is with them already, and this was only the
             * question "what became of it" (`askAgain`). A phone that has
             * itself just been put away cannot take a write for a moment, and
             * can still send its answer unasked a moment later: treating the
             * refusal as "gone" showed the payer a code to scan for a payment
             * the receiver went on to take. So nothing is given up here. The
             * wait `askAgain` set is still running, their answer ends it if
             * it comes, and that clock is the one that gives up.
             *
             * Not asked a second time: every sealed message takes the next
             * counter, this one took one and may not have arrived, and a
             * question sealed under the one after would not open at their
             * end and would stop a link that can still carry the answer
             * (TapSession, `again`). */
            if againOut {
                againOut = false
                if sendDone != nil { print("[tap] pay: they could not take the question; still waiting for their answer") }
                if closingAfterWrites { closingAfterWrites = false; stop() }
                return
            }
            if sendDone != nil { finishSend(.lost("That phone stopped taking the payment.")) }
            if closingAfterWrites { closingAfterWrites = false; stop() }
            return
        }
        if ackOut, outgoing.isEmpty {
            ackOut = false
            print("[tap] pay: the receiver was told the change was kept")
        }
        if againOut, outgoing.isEmpty { againOut = false }
        if closingAfterWrites, outgoing.isEmpty {
            closingAfterWrites = false
            stop()
            return
        }
        // a payment of many pieces says how far it has got
        if sendDone != nil, sendPieces > 12 {
            if let pct = sentSaid.step(done: sendPieces - outgoing.count, of: sendPieces) {
                progress = pct
                onStage(.sending)
            }
        }
        pumpWrites(to: p)
    }

    // MARK: the payment, over the link that is already open

    /// What became of a payment handed over: the receiver's own word on it, or
    /// why it never got that far. The two are not the same answer and used to
    /// be — a link that went falls back to the request's own transport, an
    /// answer never does, because they heard it and said something.
    enum Handover {
        /// M6 came back. The text is the receiver's answer, as it sealed it.
        case answered(String)
        /// The link went, or was never there. Nothing was confirmed.
        case lost(String)
    }

    private var sendDone: ((Handover) -> Void)?

    /// Hand the payment to the receiver. The link is still up — this phone
    /// stays subscribed until the payment is over — so there is nothing to
    /// reopen.
    func send(_ body: String, then: @escaping (Handover) -> Void) {
        dispatchPrecondition(condition: .onQueue(.main))
        guard sendDone == nil else { then(.lost("A payment is already going over.")); return }
        guard linked, let made = session, let p = target, p.state == .connected else {
            then(.lost("That phone is no longer connected."))
            return
        }
        /* The size first, sealed first, when it will take a while — so the
         * receiver can show how far it has got across all the parts. Not for
         * an ordinary payment: an older Foxy does not know the message and
         * would drop the link. Before the payment is sealed, because messages
         * open in the order they were sealed (paymentWireEstimate). */
        let wire = made.paymentWireEstimate(body)
        let size = wire > 16_000 && body.utf8.count <= TapCrypto.mostPaymentTotal
            ? made.sealPaymentSize(wire) : nil
        guard let frames = made.sealPaymentFrames(body) else {
            then(.lost("That payment could not be sealed."))
            return
        }
        sendDone = then
        paymentSent = true
        if let size { write(size, to: p) }
        frames.forEach { write($0, to: p) }
        sendPieces = outgoing.count
        progress = 0
        sentSaid = TapProgress()
    }

    /// How far the payment in hand has got, as a percentage, for the page.
    private(set) var progress = 0
    private var sendPieces = 0
    private var sentSaid = TapProgress()

    private func finishSend(_ how: Handover) {
        let tell = sendDone
        sendDone = nil
        againTimer?.invalidate(); againTimer = nil
        tell?(how)
    }

    /* Foxy is back in front with a payment handed over on this link.
     *
     * Whatever the receiver said while this app was suspended is gone: iOS
     * does not deliver it and does not keep it. So it is asked for again
     * (M12), and anything half-arrived is thrown away first so the repeat is
     * read from a clean start. And the wait is no longer the forty seconds a
     * phone that never left is given: six, from now. A receiver that is still
     * there answers in well under one; one that says nothing in six has gone,
     * and the page is told so it can stop saying SENDING. */
    private var paymentSent = false
    private var askedAgainAt: TimeInterval = 0
    private var againTimer: Timer?
    /// The question is on its way and nothing else is: a write that fails now
    /// is the question failing, not the payment (`didWriteValueFor`).
    private var againOut = false
    func askAgain() {
        dispatchPrecondition(condition: .onQueue(.main))
        let now = ProcessInfo.processInfo.systemUptime
        guard paymentSent, linked, now - askedAgainAt > 5,
              let made = session, let p = target, p.state == .connected else { return }
        askedAgainAt = now
        incoming = TapProtocol.Bytes()
        // only when nothing else is waiting to be written: then a refusal is this question's
        let alone = outgoing.isEmpty && !writing
        guard let sealed = made.sealAgain() else { return }
        print("[tap] pay: back in front with a payment handed over; asking the receiver to say it again")
        againOut = alone
        write(sealed, to: p)
        guard sendDone != nil else { return }
        againTimer?.invalidate()
        againTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in
            guard let self = self, self.sendDone != nil else { return }
            print("[tap] pay: the receiver did not say what became of it after Foxy came back")
            self.finishSend(.lost("That phone did not answer after Foxy came back."))
        }
    }
}

// MARK: - the simulator's stand-in

/* Which link the bridge builds (FoxyBridge+Tap.swift).
 *
 * A phone: the Bluetooth one above, and nothing else is compiled. The iOS
 * Simulator has no Bluetooth at all — CoreBluetooth answers `unsupported` —
 * so every screen of a tap, its cards, its refusals and its change leg could
 * only ever be driven on two phones in two hands. In the simulator the same
 * conversation is carried over a socket on the Mac's own loopback, which all
 * simulators share, so two of them can pay each other with the real page, the
 * real bridge, the real keychain and real mints behind Tor.
 *
 * It stands in for the radio and for nothing else: the page cannot tell which
 * it has. What it cannot test is the radio — range, RSSI, edges, a link that
 * drops because somebody walked away, the sealing of TapSession. Those stay
 * phone tests. */
#if targetEnvironment(simulator)
typealias TapRx = SimTapReceiver
typealias TapTx = SimTapPayer
#else
typealias TapRx = TapReceiver
typealias TapTx = TapPayer
#endif

#if targetEnvironment(simulator)
import Network

/// One line of JSON each way, on the main queue.
private final class SimWire {
    private let conn: NWConnection
    private var buffer = Data()
    private var closed = false
    var onMessage: (([String: Any]) -> Void)?
    var onClosed: (() -> Void)?
    var onReady: (() -> Void)?

    init(_ conn: NWConnection) { self.conn = conn }

    func start() {
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready: self?.onReady?()
            // a refused port is `waiting`, not `failed`: nobody is there
            case .failed, .cancelled, .waiting: self?.end()
            default: break
            }
        }
        conn.start(queue: .main)
        read()
    }

    private func read() {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, done, error in
            guard let self, !self.closed else { return }
            if let data, !data.isEmpty {
                self.buffer.append(data)
                while let at = self.buffer.firstIndex(of: 0x0a) {
                    let line = self.buffer.subdata(in: self.buffer.startIndex..<at)
                    self.buffer.removeSubrange(self.buffer.startIndex...at)
                    if let o = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] {
                        self.onMessage?(o)
                    }
                    if self.closed { return }
                }
            }
            if done || error != nil { self.end(); return }
            self.read()
        }
    }

    var open: Bool { !closed }

    func say(_ kind: String, _ body: String = "", _ more: [String: Any] = [:]) {
        guard !closed else { return }
        var o = more
        o["t"] = kind
        o["b"] = body
        guard var data = try? JSONSerialization.data(withJSONObject: o) else { return }
        data.append(0x0a)
        conn.send(content: data, completion: .contentProcessed { _ in })
    }

    func close() {
        guard !closed else { return }
        closed = true
        onMessage = nil
        onClosed = nil
        conn.cancel()
    }

    private func end() {
        guard !closed else { return }
        closed = true
        conn.cancel()
        let tell = onClosed
        onMessage = nil
        onClosed = nil
        tell?()
    }
}

/// The ports a receiver may be on. More than one, because two simulators can
/// both be on their receive screens.
private enum SimTap {
    static let ports: [UInt16] = Array(47411...47418)
    /// This app, so its own payer does not answer its own receiver.
    static let me = UUID().uuidString
}

/// `TapReceiver`, over loopback. The same surface and the same answers.
final class SimTapReceiver {
    static let resultWait: TimeInterval = TapReceiver.resultWait

    private let onEvent: (TapStage, String?) -> Void
    private let onPaid: (String, @escaping (Int, String) -> Void) -> Void
    private let onQuote: (String) -> Void
    private var payload: String
    private var listener: NWListener?
    private var wires: [SimWire] = []
    private var near: [SimWire] = []
    private var talking: SimWire?
    private var linked = false
    private var offerSent = false
    private var resultSent = false
    private var paymentHeard = false
    private var finished = false
    private var stopping = false
    private var armed = false
    private var changeOwed = false
    private var changeTaken = false
    private var resultTimer: Timer?
    /// What went out after the code, in order, for a payer that asks again.
    private var out: [(String, String)] = []

    var onChangeAnswered: ((Bool) -> Void)?
    var turned = false { didSet { if turned != oldValue { tellDoor() } } }
    var early = false { didSet { if early != oldValue { tellDoor() } } }

    init(payload: String, onEvent: @escaping (TapStage, String?) -> Void,
         onPaid: @escaping (String, @escaping (Int, String) -> Void) -> Void = { _, _ in },
         onQuote: @escaping (String) -> Void = { _ in }) {
        self.payload = payload
        self.onEvent = onEvent
        self.onPaid = onPaid
        self.onQuote = onQuote
    }

    func start() {}

    func update(payload: String) {
        self.payload = payload
        sendOfferIfReady()
    }

    func arm() {
        guard !armed else { return }
        armed = true
        listen(0)
    }

    private func listen(_ i: Int) {
        guard armed, !finished else { return }
        guard i < SimTap.ports.count, let port = NWEndpoint.Port(rawValue: SimTap.ports[i]) else {
            print("[tap] sim receive: no free port; nobody can find this simulator")
            return
        }
        let params = NWParameters.tcp
        // this Mac only: nothing on the network can reach it
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
        guard let l = try? NWListener(using: params) else { listen(i + 1); return }
        l.stateUpdateHandler = { [weak self, weak l] state in
            guard let self, let l, self.listener === l else { return }
            switch state {
            case .ready: print("[tap] sim receive: on the air at port \(port.rawValue)")
            case .failed, .waiting:
                l.cancel()
                self.listener = nil
                self.listen(i + 1)
            default: break
            }
        }
        l.newConnectionHandler = { [weak self] conn in self?.joined(SimWire(conn)) }
        listener = l
        l.start(queue: .main)
    }

    private var doorByte: Int { (turned ? 1 : 0) | (early ? 2 : 0) }
    private func tellDoor() { near.forEach { $0.say("door", "", ["byte": doorByte, "id": SimTap.me]) } }

    private func joined(_ w: SimWire) {
        guard !finished else { w.close(); return }
        wires.append(w)
        w.onMessage = { [weak self, weak w] o in if let w { self?.heard(o, from: w) } }
        w.onClosed = { [weak self, weak w] in if let w { self?.went(w) } }
        w.start()
    }

    private func heard(_ o: [String: Any], from w: SimWire) {
        let kind = (o["t"] as? String) ?? "", body = (o["b"] as? String) ?? ""
        if kind == "near" {
            if !near.contains(where: { $0 === w }) { near.append(w) }
            w.say("door", "", ["byte": doorByte, "id": SimTap.me])
            if !linked, talking == nil { onEvent(.nearby, body == "right" ? "right" : "left") }
            return
        }
        if kind == "hello" {
            guard !linked else { return }
            guard !early else {
                print("[tap] sim receive: a payer tried to join on the amount screen; not yet")
                return
            }
            guard talking == nil || talking === w else {
                print("[tap] sim receive: another phone tried to join; ignored")
                return
            }
            talking = w
            onEvent(.connecting, nil)
            let code = String(format: "%04d", Int.random(in: 0...9999))
            linked = true
            w.say("code", code)
            onEvent(.code, code)
            sendOfferIfReady()
            return
        }
        guard w === talking else {
            print("[tap] sim receive: a word from a phone that is not the payer; refused")
            return
        }
        switch kind {
        case "pay":
            guard !resultSent, !paymentHeard else { return }
            paymentHeard = true
            resultTimer?.invalidate()
            resultTimer = Timer.scheduledTimer(withTimeInterval: Self.resultWait, repeats: false) { [weak self] _ in
                self?.sealResult(504, "Their wallet did not answer in time.")
            }
            onPaid(body) { [weak self] status, why in
                DispatchQueue.main.async { self?.sealResult(status, why) }
            }
        case "again":
            let from = max(0, (o["from"] as? Int) ?? 0)
            let late = out.dropFirst(from)
            print("[tap] sim receive: the payer was away; saying \(late.count) message(s) again")
            late.forEach { w.say($0.0, $0.1) }
        case "kept":
            changeOwed = false
            changeTaken = true
            print("[tap] sim receive: the payer kept the change")
            changeAnswered(true)
        case "quote":
            print("[tap] sim receive: a word from the payer arrived (a price, a question, or paid), handing it to the page")
            onQuote(body)
        default:
            break
        }
    }

    private func went(_ w: SimWire) {
        wires.removeAll { $0 === w }
        let wasNear = near.contains { $0 === w }
        near.removeAll { $0 === w }
        if wasNear, near.isEmpty { onEvent(.far, nil) }
        guard w === talking else { return }
        if busy {
            print("[tap] sim receive: the payer went away with a payment in flight")
            if !resultSent { onEvent(.gone, nil) }
            if !paymentHeard { resultTimer?.invalidate(); resultTimer = nil }
            if changeOwed && !changeTaken {
                changeOwed = false
                print("[tap] sim receive: the payer has gone, so the change is no longer waited for")
                changeAnswered(false)
            }
            return
        }
        guard !linked else {
            if !resultSent {
                print("[tap] sim receive: the payer went away after the link was made")
                onEvent(.gone, nil)
            }
            return
        }
        talking = nil
        offerSent = false
    }

    private func push(_ kind: String, _ body: String) -> Bool {
        guard linked, !finished, let w = talking, w.open else { return false }
        out.append((kind, body))
        w.say(kind, body)
        return true
    }

    private func sendOfferIfReady() {
        guard linked, !offerSent, !finished, TapProtocol.isPayload(payload) else { return }
        if push("offer", payload) { offerSent = true }
    }

    private func changeAnswered(_ kept: Bool) {
        let tell = onChangeAnswered
        onChangeAnswered = nil
        tell?(kept)
    }

    var busy: Bool {
        if changeOwed && !changeTaken { return true }
        return !resultSent && resultTimer != nil
    }

    func expectChange() {
        guard linked, !finished else { return }
        changeOwed = true
        changeTaken = false
        print("[tap] sim receive: change is owed, so this link stays up for it")
    }

    func sendTerms(_ text: String) -> Bool {
        guard push("terms", text) else { return false }
        print("[tap] sim receive: the price was agreed; the request is on its way")
        return true
    }

    func sendAsking() -> Bool {
        guard !resultSent, push("asking", "") else { return false }
        resultTimer?.invalidate()
        resultTimer = Timer.scheduledTimer(withTimeInterval: TapReceiver.askingWait, repeats: false) { [weak self] _ in
            self?.sealResult(504, "They did not answer in time.")
        }
        print("[tap] sim receive: telling the payer a person is deciding")
        return true
    }

    func sendChange(_ text: String) -> Bool {
        guard push("change", text) else {
            print("[tap] sim receive: no link to hand the change over")
            return false
        }
        changeOwed = true
        changeTaken = false
        print("[tap] sim receive: change sent, waiting for the payer to keep it")
        return true
    }

    var takenOne: Bool { offerSent }
    var withPayer: Bool { linked && offerSent && !resultSent }

    private func sealResult(_ code: Int, _ why: String) {
        guard !resultSent else { return }
        resultTimer?.invalidate(); resultTimer = nil
        resultSent = true
        let ok = code == 200
        let fields: [String: Any] = ok ? ["v": 2, "ok": true, "code": 200]
            : ["v": 2, "ok": false, "code": code, "why": String(why.prefix(160))]
        let json = (try? JSONSerialization.data(withJSONObject: fields))
            .flatMap { String(data: $0, encoding: .utf8) }
            ?? "{\"v\":2,\"ok\":\(ok),\"code\":\(code)}"
        guard push("result", json) else {
            print("[tap] sim receive: the page answered \(code) and the payer has gone; nobody to tell")
            return
        }
        print("[tap] sim receive: the page answered \(code); telling the payer")
        if stopping && !(changeOwed && !changeTaken) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                guard let self, !(self.changeOwed && !self.changeTaken) else { return }
                self.reallyStop()
            }
        }
    }

    func stop(whenIdle: (() -> Void)? = nil) -> Bool {
        if busy, !stopping {
            stopping = true
            print("[tap] sim receive: a payment is crossing; the link stays until it is answered")
            DispatchQueue.main.asyncAfter(deadline: .now() + Self.resultWait + 2) { [weak self] in
                self?.reallyStop()
                whenIdle?()
            }
            return false
        }
        reallyStop()
        return true
    }

    private func reallyStop() {
        guard !finished else { return }
        changeAnswered(false)
        finished = true
        stopping = false
        armed = false
        resultTimer?.invalidate(); resultTimer = nil
        listener?.cancel()
        listener = nil
        let all = wires
        wires.removeAll()
        near.removeAll()
        talking = nil
        all.forEach { $0.close() }
    }
}

/// `TapPayer`, over loopback. "Near" is any simulator on its receive screen.
/// "Touching" is a file: the payer's card is not a button (26e-loaders.js), so
/// on a phone only the touch takes the link, and here a file named `sim-touch`
/// in the app's Documents folder is that touch. It is used up by the link it
/// makes.
///
///     touch "$(xcrun simctl get_app_container <device> <bundle id> data)/Documents/sim-touch"
final class SimTapPayer {
    private let onStage: (TapStage) -> Void
    private let done: (String, String) -> Void
    private let onChange: (String, @escaping (Bool) -> Void) -> Void
    private let onTerms: (String) -> Void
    private var wire: SimWire?
    private var next = 0
    private var tick: Timer?
    private var giveUp: Timer?
    private var againTimer: Timer?
    private var linked = false
    private var finished = false
    private var heardDoor = false
    private var theirEarly = false
    private var theirTurned = false
    private var nearSaid = false
    private var asked = false
    private var code = ""
    private var heard = 0
    private var paymentSent = false
    private var sendDone: ((TapPayer.Handover) -> Void)?
    private(set) var progress = 0

    var edge: String { theirTurned ? "left" : "right" }

    init(onStage: @escaping (TapStage) -> Void,
         onChange: @escaping (String, @escaping (Bool) -> Void) -> Void = { _, keep in keep(false) },
         onTerms: @escaping (String) -> Void = { _ in },
         done: @escaping (String, String) -> Void) {
        self.onStage = onStage
        self.done = done
        self.onChange = onChange
        self.onTerms = onTerms
    }

    func start() {
        tick = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.look() }
        look()
    }

    private static let touchFile = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)
        .first?.appendingPathComponent("sim-touch").path ?? ""

    private func look() {
        guard !finished, !linked else { return }
        if wire == nil { next = 0; knock(); return }
        guard heardDoor, !theirEarly, !asked else { return }
        // said about once a second while it holds, as the radio says it
        nearSaid = true
        onStage(.nearby)
        if !Self.touchFile.isEmpty, FileManager.default.fileExists(atPath: Self.touchFile) {
            try? FileManager.default.removeItem(atPath: Self.touchFile)
            print("[tap] sim pay: the phones touched")
            take()
        }
    }

    /// Every port in turn, at once: a port nobody is on refuses in a moment.
    private func knock() {
        guard !finished, !linked, next < SimTap.ports.count,
              let port = NWEndpoint.Port(rawValue: SimTap.ports[next]) else { return }
        next += 1
        let w = SimWire(NWConnection(host: "127.0.0.1", port: port, using: .tcp))
        wire = w
        w.onReady = { [weak w] in w?.say("near", "left") }
        w.onMessage = { [weak self, weak w] o in if let w, self?.wire === w { self?.got(o) } }
        w.onClosed = { [weak self, weak w] in if let w, self?.wire === w { self?.lost() } }
        w.start()
    }

    private func got(_ o: [String: Any]) {
        let kind = (o["t"] as? String) ?? "", body = (o["b"] as? String) ?? ""
        if kind == "door" {
            // this app's own receive screen is not somebody to pay
            if (o["id"] as? String) == SimTap.me { wire?.close(); wire = nil; knock(); return }
            let byte = (o["byte"] as? Int) ?? 0
            heardDoor = true
            theirTurned = byte & 1 == 1
            let isEarly = byte & 2 == 2
            if isEarly != theirEarly {
                theirEarly = isEarly
                print("[tap] sim pay: that phone is \(isEarly ? "still on its amount screen; no card yet" : "on its invoice screen")")
                if isEarly, nearSaid { nearSaid = false; onStage(.far) }
            }
            if !theirEarly, !asked, !linked { nearSaid = true; onStage(.nearby) }
            return
        }
        if kind == "code" { code = body; return }
        heard += 1
        switch kind {
        case "offer":
            linked = true
            giveUp?.invalidate(); giveUp = nil
            tick?.invalidate(); tick = nil
            onStage(.linked)
            done(body, code)
        case "result":
            print("[tap] sim pay: the receiver said \(body.prefix(60))")
            finishSend(.answered(body))
        case "change":
            print("[tap] sim pay: change arrived, handing it to the page")
            onChange(body) { [weak self] kept in
                DispatchQueue.main.async {
                    guard let self, kept, !self.finished else { return }
                    print("[tap] sim pay: change written down; telling the receiver")
                    self.wire?.say("kept")
                }
            }
        case "asking":
            print("[tap] sim pay: they are asking a person; waiting")
            onStage(.asking)
        case "terms":
            print("[tap] sim pay: they agreed the price; the request is in")
            onTerms(body)
        default:
            break
        }
    }

    private func lost() {
        let knocking = !heardDoor && !asked && !linked
        wire = nil
        heardDoor = false
        theirEarly = false
        // nobody on that port: the next one, now
        if knocking, sendDone == nil, !nearSaid { knock(); return }
        if sendDone != nil {
            finishSend(.lost("That phone went away before it said what became of the payment."))
            return
        }
        guard !finished, !linked else { return }
        if asked {
            print("[tap] sim pay: gave up on that one (disconnected); looking again")
            onStage(.gone)
            onStage(.searching)
        } else if nearSaid {
            onStage(.far)
        }
        giveUp?.invalidate(); giveUp = nil
        asked = false
        nearSaid = false
        code = ""
        heard = 0
    }

    func connectNearby() {
        guard wire != nil, heardDoor, !theirEarly, !asked, !linked, !finished else { return }
        print("[tap] sim pay: TAP TO PAY pressed; taking that receiver")
        take()
    }

    private func take() {
        guard let w = wire, heardDoor, !theirEarly, !asked, !linked, !finished else { return }
        asked = true
        onStage(.connecting)
        w.say("hello")
        giveUp?.invalidate()
        giveUp = Timer.scheduledTimer(withTimeInterval: 30, repeats: false) { [weak self] _ in
            guard let self, !self.linked, !self.finished else { return }
            print("[tap] sim pay: nothing came after the handshake")
            let w = self.wire
            self.lost()
            w?.close()
        }
    }

    func sendQuote(_ text: String) -> Bool {
        guard linked, let w = wire, w.open else { return false }
        w.say("quote", text)
        print("[tap] sim pay: sent the receiver a word on the link (a price, a question, or paid)")
        return true
    }

    func send(_ body: String, then: @escaping (TapPayer.Handover) -> Void) {
        guard sendDone == nil else { then(.lost("A payment is already going over.")); return }
        guard linked, let w = wire, w.open else {
            then(.lost("That phone is no longer connected."))
            return
        }
        sendDone = then
        paymentSent = true
        w.say("pay", body)
    }

    private func finishSend(_ how: TapPayer.Handover) {
        let tell = sendDone
        sendDone = nil
        againTimer?.invalidate(); againTimer = nil
        tell?(how)
    }

    func askAgain() {
        guard paymentSent, linked, let w = wire, w.open else { return }
        print("[tap] sim pay: back in front with a payment handed over; asking the receiver to say it again")
        w.say("again", "", ["from": heard])
        guard sendDone != nil else { return }
        againTimer?.invalidate()
        againTimer = Timer.scheduledTimer(withTimeInterval: 6, repeats: false) { [weak self] _ in
            guard let self, self.sendDone != nil else { return }
            self.finishSend(.lost("That phone did not answer after Foxy came back."))
        }
    }

    func stop() {
        finished = true
        tick?.invalidate(); tick = nil
        giveUp?.invalidate(); giveUp = nil
        let w = wire
        wire = nil
        w?.close()
        if sendDone != nil { finishSend(.lost("Nobody is connected any more.")) }
    }
}
#endif
