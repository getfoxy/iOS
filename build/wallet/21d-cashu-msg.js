    /* ---- messages between Cashu IDs (08f-cashu-msg.js, docs/CASHU-ID.md "Messages") -------------
     *
     * For the screens: CONTACTS shows each contact's unread count (`cashuMsgThreads`), a contact's screen its messages
     * (`cashuMsgThread`) and SEND writes one (`cashuMsgSend`). Only once this phone's ID is in use (`cashuMsgOn`): with
     * no ID in use there are no messages, none are listened for and none can be written. */

    // whether messages can be read and written here: MY CASHU ID was shown, or its words restored
    cashuMsgOn: function () { return cidInUse(); },

    /* The conversations: { peer, name, contact, unread, lastAt, lastText }, contacts and the people who are not contacts
     * yet that wrote ([] with no ID in use). */
    cashuMsgThreads: function () { return cmsgThreadsNow(); },

    /* One conversation, oldest first: { peer, name, contact, card, unread, msgs: [{ id, dir, text, at, mark }] }, `mark`
     * 'sending…' or 'sent' for this phone's own, `card` the ID string of someone who is not a contact. null
     * for none. */
    cashuMsgThread: function (peer) {
      if (!cidInUse()) return null;
      var p = String(peer || '').toLowerCase();
      var t = cmsgThread(cmsgAll(), p, false);
      if (!t && cidContactOf(p)) t = cmsgNewThread(p);
      return t ? cmsgView(t) : null;
    },

    /* The payments to and from Cashu IDs that INBOX lists beside the messages, newest first: { peer, dir, unit,
     * amount, at } (`cmsgPaymentsNow`). */
    cashuMsgPayments: function () { return cmsgPaymentsNow(); },

    // their messages read: the unread count goes to 0
    cashuMsgSeen: function (peer) { cmsgRead1(peer); },

    /* Write to a contact (its ID key or ID string): resolves { id, i, first } once it is kept and waiting to go; rejects
     * in words. */
    cashuMsgSend: function (peer, text) { return cmsgSend(peer, text); },

    cashuMsgListen: function () { return cmsgListenNow(); },
    cashuMsgDeliver: function () { return cmsgDeliverAll(); },

    /* One message from the phone (`cashuIdMsgOpen`): 'kept', 'seen' or 'refused'; never rejects. */
    _cashuMsgArrived: function (peer, way, i, body) { return cmsgArrived(peer, way, Number(i), body); },

    // the suites' waits (honoured only on a test's page, `CID_TESTS`)
    _cashuMsgDelayMs: undefined,
    _cashuMsgRetryMs: 0,
    _cashuMsgReopenMs: 0,

