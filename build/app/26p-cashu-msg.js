  /* ---- messages between Cashu IDs: a contact's screen ---------------------------------------------------------------
   *
   * The wallet's half is 08f-cashu-msg.js and docs/CASHU-ID.md ("Messages"). Here:
   *
   *   CONTACTS ................... a contact that is a Cashu ID opens its own screen (`cidOpen`); its row carries how many
   *                                of its messages are unread. Someone who is not a contact and wrote (their first message
   *                                carries their ID string) is under NEW MESSAGES, as "A Cashu ID".
   *   the contact's screen ....... its name, PAY (the payment to a contact, `cidPayStart`), the messages oldest at the top
   *                                and newest at the bottom, each of this phone's own marked "sending…" until a relay took it
   *                                and "sent" after, and a field with SEND. Someone who is not a contact has
   *                                ADD CONTACT in place of PAY (NAME THIS CONTACT?, with the ID string they sent).
   *   no ID in use ............... no messages, no counts, no field: the screen says to open MY CASHU ID first, and PAY
   *                                works as before.
   *   CHAT ....................... home's round button at the top left (where CARD was; FOXY CARD is now the first row of
   *                                the menu's WALLET), with the number of unread messages on its corner, "9+" past nine. It opens
   *   INBOX ...................... everyone this phone has written to, heard from, paid or been paid by, newest first by
   *                                the latest of those, each with the last message's first line or the payment
   *                                ("Paid $1.25", "Received 500 sats"), its time, and its unread count; a row opens that
   *                                contact's screen (`cidOpen`). */

  /* A contact (from CONTACTS) or a conversation's peer: its screen. Opening it marks its messages read. */
  cidOpen(c) {
    const W = window.FoxyWallet;
    const peer = c && c.cid ? String(c.cid.id || '') : String((c && c.peer) || '');
    if (!peer) return;
    this.setState(p => ({ screen: 'cidChat', stack: p.stack.concat([p.screen]), cmPeer: peer, cmDraft: '', cmErr: '', cmBusy: false }));
    if (W && W.cashuMsgOn && W.cashuMsgOn() && W.cashuMsgSeen) { W.cashuMsgSeen(peer); this.cmTick(); }
  }

  // something changed in the messages: what reads them reads again
  cmTick() { this.setState(p => ({ cmsgTick: (p.cmsgTick || 0) + 1 })); }

  /* The conversations, read once for each change (`cmsgTick`): by peer, for the contacts' counts and NEW MESSAGES. */
  cmThreads() {
    const W = window.FoxyWallet;
    const tick = this.state.cmsgTick || 0;
    const on = !!(W && W.cashuMsgOn && W.cashuMsgOn());
    const n = (this.state.contacts || []).length;
    const m = this._cmMemo;
    if (m && m.w === W && m.on === on && m.tick === tick && m.n === n) return m.list;
    let list = [];
    try { list = (on && W.cashuMsgThreads) ? W.cashuMsgThreads() : []; } catch (e) { list = []; }
    this._cmMemo = { w: W, on: on, tick: tick, n: n, list: list };
    return list;
  }

  // a contact's unread count as its row says it: '' for none, '99+' past 99
  cmUnreadOf(peer) {
    const t = this.cmThreads().find((v) => v.peer === peer);
    const n = t ? Number(t.unread) || 0 : 0;
    return n <= 0 ? '' : n > 99 ? '99+' : String(n);
  }

  /* NEW MESSAGES: people who are not contacts and wrote, newest first. */
  cmNewRows() {
    return this.cmThreads().filter((v) => !v.contact && v.lastAt > 0)
      .sort((a, b) => b.lastAt - a.lastAt)
      .map((v) => {
        const n = Number(v.unread) || 0;
        return {
          name: 'A Cashu ID', handle: 'Not in your contacts', ini: '?',
          unread: n <= 0 ? '' : n > 99 ? '99+' : String(n), unreadSay: n + (n === 1 ? ' unread message' : ' unread messages'),
          tap: () => this.cidOpen({ peer: v.peer }),
        };
      });
  }

  /* ---- CHAT and INBOX ---- */

  // every unread message, across the conversations
  cmUnreadTotal() {
    return this.cmThreads().reduce((n, v) => n + Math.max(0, Number(v.unread) || 0), 0);
  }

  // CHAT's corner: '' for none, '9+' past nine
  cmBadgeOf(n) {
    return n <= 0 ? '' : n > 9 ? '9+' : String(n);
  }

  // CHAT, from home: INBOX, with the conversations read again
  goInbox() {
    this.setState(p => ({ screen: 'inbox', stack: p.stack.concat([p.screen]), cmsgTick: (p.cmsgTick || 0) + 1 }));
  }

  // an amount as INBOX says a payment: "$1.25", "500 sats", "1 sat"
  cmSaid(amount, unit) {
    const v = Math.round(Number(amount) || 0);
    if (unit === 'usd') return '$' + (v / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return v.toLocaleString('en-US') + (v === 1 ? ' sat' : ' sats');
  }

  /* INBOX's rows: one for each peer with a message or a payment either way, newest first by the latest of them. A
   * message's row says its first line; a payment's, what it was. The name is the contact's, or "A Cashu ID" for someone
   * who is not one. */
  cmInboxRows() {
    const W = window.FoxyWallet;
    const by = {};
    const at = (peer) => (by[peer] = by[peer] || { peer: peer, lastAt: 0, line: '', unread: 0, name: '', contact: false });
    this.cmThreads().forEach((v) => {
      if (!(Number(v.lastAt) > 0)) return;
      const r = at(String(v.peer));
      r.unread = Math.max(0, Number(v.unread) || 0);
      r.name = v.contact ? String(v.name || '') : '';
      r.contact = !!v.contact;
      if (v.lastAt > r.lastAt) { r.lastAt = Number(v.lastAt); r.line = String(v.lastText || '').split('\n')[0]; }
    });
    let pays = [];
    try { pays = (W && W.cashuMsgPayments) ? W.cashuMsgPayments() || [] : []; } catch (e) { pays = []; }
    pays.forEach((p) => {
      if (!p || !p.peer || !(Number(p.at) > 0)) return;
      const r = at(String(p.peer));
      if (p.at > r.lastAt) {
        r.lastAt = Number(p.at);
        r.line = (p.dir === 'out' ? 'Paid ' : 'Received ') + this.cmSaid(p.amount, p.unit);
      }
    });
    const book = this.state.contacts || [];
    return Object.keys(by).map((k) => by[k]).sort((a, b) => b.lastAt - a.lastAt).map((r) => {
      const c = book.find((x) => x && x.cid && String(x.cid.id || '').toLowerCase() === r.peer) || null;
      const name = c ? String(c.name || 'Cashu ID') : r.name || 'A Cashu ID';
      const known = !!c || r.contact;
      const n = r.unread;
      return {
        key: r.peer, name: name, ini: known ? (name.charAt(0).toUpperCase() || '?') : '?', known: known, stranger: !known,
        line: r.line, time: this.cmWhen(r.lastAt),
        unread: n <= 0 ? '' : n > 99 ? '99+' : String(n), unreadSay: n + (n === 1 ? ' unread message' : ' unread messages'),
        tap: () => this.cidOpen({ peer: r.peer }),
      };
    });
  }

  /* CHAT's values on home, and INBOX's on its own screen. */
  renderInbox(c) {
    const { sc } = c;
    const n = this.cmUnreadTotal();
    const badge = this.cmBadgeOf(n);
    const home = {
      goChat: () => this.goInbox(),
      chatBadge: badge,
      chatBadgeShown: !!badge,
      chatSay: n > 0 ? 'Chat, ' + n + (n === 1 ? ' unread message' : ' unread messages') : 'Chat',
    };
    // (not `sc === …`: render-snapshots.js draws this screen in messageViews, after the others, so their numbers stay)
    if (sc !== 'inbox') return Object.assign(home, { isInbox: false });
    const W = window.FoxyWallet;
    const on = !!(W && W.cashuMsgOn && W.cashuMsgOn());
    const rows = this.cmInboxRows();
    return Object.assign(home, {
      isInbox: true,
      ibRows: rows,
      ibAny: rows.length > 0,
      ibOffShown: !on,
      ibOffText: 'Messages go from your own Cashu ID. Open MY CASHU ID in the menu to start.',
      ibEmptyShown: on && rows.length === 0,
      ibEmpty: 'No conversations yet. Share MY CASHU ID to be paid or messaged.',
    });
  }

  // a message's time as HISTORY says one
  cmWhen(at) {
    const d = new Date(Number(at) || Date.now());
    return this.txLabel ? this.txLabel(d, new Date()) : d.toISOString();
  }

  /* SEND: kept and waiting to go (the wallet's random wait, then the relays), or why not, under the field. */
  cmSendGo() {
    const W = window.FoxyWallet;
    const s = this.state;
    if (!W || !W.cashuMsgSend || s.cmBusy) return;
    const text = String(s.cmDraft || '');
    if (!text.trim()) { this.setState({ cmErr: 'Type a message first.' }); return; }
    this.setState({ cmBusy: true, cmErr: '' });
    Promise.resolve(W.cashuMsgSend(s.cmPeer, text)).then(() => {
      this.setState({ cmBusy: false, cmDraft: '', cmErr: '' });
      this.cmTick();
    }).catch((e) => {
      this.setState({ cmBusy: false, cmErr: W.reason ? W.reason(e) : String((e && e.message) || e) });
    });
  }

  /* PAY for a contact (the payment to a contact, as from CONTACTS before); ADD CONTACT for someone who is not one. */
  cmPayGo(view) {
    if (view && view.contact) {
      const c = (this.state.contacts || []).find((x) => x && x.cid && x.cid.id === view.peer);
      if (c) { this.cidPayStart(c); return; }
    }
    if (view && view.card) { this.cidNameAsk(view.card, ''); return; }
    this.toast('Add them to your contacts first.', true);
  }

  /* The screen's values. With no ID in use: the contact's name, PAY, and why there are no messages. */
  renderCidChat(c) {
    const { s, sc } = c;
    // (not `sc === …`: render-snapshots.js draws this screen in messageViews, after the others, so their numbers stay)
    if (sc !== 'cidChat') return { isCidChat: false };
    const W = window.FoxyWallet;
    const on = !!(W && W.cashuMsgOn && W.cashuMsgOn());
    const contact = (s.contacts || []).find((x) => x && x.cid && x.cid.id === s.cmPeer) || null;
    let view = null;
    try { view = on && W.cashuMsgThread ? W.cashuMsgThread(s.cmPeer) : null; } catch (e) { view = null; }
    const name = contact ? String(contact.name || 'Cashu ID') : (view && view.name) || 'A Cashu ID';
    const isContact = !!contact;
    const msgs = (view && view.msgs) || [];
    const rows = msgs.slice().reverse().map((m) => {
      const mine = m.dir === 'out';
      return {
        text: m.text, align: mine ? 'flex-end' : 'flex-start',
        bg: mine ? 'var(--acc)' : 'var(--surface)', ink: mine ? '#fff' : 'var(--ink)',
        foot: this.cmWhen(m.at) + (mine && m.mark ? ' · ' + m.mark : ''),
      };
    });
    const busy = !!s.cmBusy;
    return {
      isCidChat: true,
      cmTitle: name.toUpperCase(),
      cmSub: on ? (isContact ? 'Messages go over Nostr, each to a key used once.' : 'Not in your contacts.') : 'CASHU ID',
      cmPayLabel: isContact ? 'PAY' : 'ADD CONTACT',
      cmPayGo: () => this.cmPayGo({ contact: isContact, peer: s.cmPeer, card: (view && view.card) || '' }),
      cmOn: on,
      cmOff: !on,
      cmOffText: 'Messages go from your own Cashu ID. Open MY CASHU ID in the menu to start, then write to ' + name + ' here.',
      cmRows: rows,
      cmEmptyShown: on && rows.length === 0,
      cmEmpty: 'No messages with ' + name + ' yet. What you write goes only to them.',
      cmDraft: s.cmDraft || '',
      cmDraftInput: (e) => this.setState({ cmDraft: String(e.target.value || '').slice(0, 1000), cmErr: '' }),
      cmPlaceholder: 'Message ' + name,
      cmSendGo: () => this.cmSendGo(),
      cmSendLabel: busy ? 'SENDING…' : 'SEND',
      cmSendBg: String(s.cmDraft || '').trim() && !busy ? 'var(--acc)' : 'rgba(var(--ink-rgb),.2)',
      cmErrShown: !!s.cmErr,
      cmErr: s.cmErr || '',
    };
  }

  /* On every return to the foreground, with the Cashu ID's (`cidWake`): a message in, or one gone to a relay, and the
   * screens read again; the open conversation's are read as they come. */
  cmWake() {
    const W = window.FoxyWallet;
    if (!W) return;
    W._onCashuMsg = (peer) => {
      if (this.state.screen === 'cidChat' && this.state.cmPeer === peer && W.cashuMsgSeen) W.cashuMsgSeen(peer);
      this.cmTick();
    };
  }
