  /* ---- SHOPS: the shops this phone collects for (08g-shop-collect.js, docs/FOXY-ID.md "Shops") --------------------------
   *
   *   SHOPS (the menu's WALLET, under MY FOXY ID) ... the SWITCH MINT list in a mode of its own (`tillList` 'shops', as the
   *                                till's lists are): each shop a row, its name, and under it its host, when it was last
   *                                collected from and the collaborators it paid by name (a contact's, or the Foxy ID's
   *                                start), so an ID swapped at the shop shows here; COLLECTING n OF N on it while it runs.
   *                                PASTE A SHOP LINK and SCAN A SHOP LINK add one; a row tapped shows it, with REMOVE.
   *   a collection ................ said once as it starts ("Collecting N sales from <shop>") and once as it ends ("N sales
   *                                collected from <shop>"); nothing when nothing waited. The app stays usable throughout.
   *   HISTORY ...................... one RECEIVED row a collection, "N sales from <shop>", whose screen lists every order with
   *                                its amount (SALES, COPY ORDERS); one SENT row for each collaborator. */

  shopsOpen() { this.tillListGo('shops'); }

  // "Ana, Ben, Foxy ID 1a2b3c4d" for the collaborators a shop has paid, newest first
  shopPaidWords(paid) {
    const names = (paid || []).map((p) => String((p && p.name) || '')).filter(Boolean);
    if (!names.length) return '';
    return 'Paid ' + names.slice(0, 4).join(', ') + (names.length > 4 ? ' +' + (names.length - 4) : '');
  }

  /* The list's values in its 'shops' mode (26p-till-tips.js `tillListVals`). */
  shopListVals() {
    const W = window.FoxyWallet;
    const list = (W && W.shops) ? W.shops() : [];
    const prog = this.state.shopProg || null;
    const rows = list.map((sh) => {
      const busy = !!(prog && prog.id === sh.id);
      const when = sh.lastAt ? 'Collected ' + this.tillExpiresText(sh.lastAt) : 'Not collected yet';
      return {
        name: sh.name, host: [sh.host, when, this.shopPaidWords(sh.paid)].filter(Boolean).join(' · '),
        text: busy ? 'COLLECTING ' + this.group(prog.n) + (prog.of ? ' OF ' + this.group(prog.of) : '') : '',
        ink: busy ? 'var(--acc-ink)' : 'rgba(var(--ink-rgb),.55)',
        dim: '1', down: false, downText: '', tint: 'var(--acc)', logo: 'none', here: false, notHere: true, busy: false,
        bg: 'var(--surface)', border: 'rgba(var(--ink-rgb),.12)', initial: String(sh.name || '?').slice(0, 1).toUpperCase(),
        tap: () => this.shopShow(sh),
      };
    });
    return {
      title: 'SHOPS',
      line: rows.length ? 'Foxy collects their sales when it opens and every ten minutes, and pays each collaborator their share.'
        : 'Add the link your shop shows its keeper. Its sales come to your Foxy ID here.',
      rows, past: [],
      add: { shown: true, label: 'PASTE A SHOP LINK', tap: () => this.shopPaste() },
      next: { shown: true, on: true, label: 'SCAN A SHOP LINK', tap: () => this.shopScan() },
    };
  }

  shopPaste() {
    this.blockedCard('shopPaste', {
      tone: 'ask', title: 'PASTE A SHOP LINK',
      reason: 'The link your shop shows its keeper. It starts foxyshop:',
      field: { value: '', placeholder: 'foxyshop:https://…', max: 600 },
      retry: 'ADD', go: (text) => this.shopAddGo(text),
      shut: { label: 'CANCEL' },
    });
  }

  shopScan() {
    const W = window.FoxyWallet;
    if (!W || !W.scan) return;
    Promise.resolve(W.scan('Scan a shop link')).then((text) => { if (String(text || '').trim()) this.shopAddGo(text); }).catch(() => {});
  }

  shopAddGo(text) {
    const W = window.FoxyWallet;
    if (!W || !W.shopAdd) return;
    try {
      const sh = W.shopAdd(String(text || ''));
      this.setState({ menuTick: (this.state.menuTick || 0) + 1 });
      this.toast(sh.name + ' added. Its sales come here.');
    } catch (e) {
      this.blockedCard('shopBad', {
        tone: 'warn', title: 'THAT WON’T WORK',
        reason: (W.reason ? W.reason(e) : String((e && e.message) || e)) || 'That is not a shop link.',
        chip: 'Copy the link from your shop again.',
      });
    }
  }

  // a shop tapped: what it is, and REMOVE
  shopShow(sh) {
    const W = window.FoxyWallet;
    const paid = this.shopPaidWords(sh.paid);
    this.blockedCard('shopShow', {
      tone: 'ask', title: String(sh.name || 'SHOP').toUpperCase(),
      reason: sh.host + '. ' + (sh.lastAt ? 'Last collected ' + this.tillExpiresText(sh.lastAt) + '.' : 'Not collected from yet.')
        + (paid ? ' ' + paid + '.' : '') + (sh.lastWhy ? ' ' + sh.lastWhy + '.' : ''),
      retry: 'DONE', go: () => {},
      shut: { label: 'REMOVE', pill: true, tap: () => {
        if (W && W.shopRemove) W.shopRemove(sh.id);
        this.setState({ menuTick: (this.state.menuTick || 0) + 1 });
        this.toast(sh.name + ' removed');
      } },
    });
  }

  /* What the wallet says as a collection goes (`_onShopCollect`): once as it starts, its count on the shop's row while it
   * runs (no oftener than twice a second), and once as it ends. */
  shopHeard(ev) {
    if (!ev) return;
    if (ev.state === 'paying') return;
    if (ev.state === 'collecting') {
      if (!(Number(ev.n) > 0)) this.toast('Collecting ' + this.shopSalesWords(ev.of) + ' from ' + ev.shop);
      const now = Date.now();
      if (!(Number(ev.n) > 0) || now - (this._shopProgAt || 0) > 500) {
        this._shopProgAt = now;
        this.setState({ shopProg: { id: ev.id, n: Number(ev.n) || 0, of: Number(ev.of) || 0 } });
      }
      return;
    }
    if (this.state.shopProg) this.setState({ shopProg: null });
    if (ev.state === 'collected' && Number(ev.n) > 0) {
      this.toast(this.shopSalesWords(ev.n) + ' collected from ' + ev.shop);
      if (this.refreshBalance) this.refreshBalance();
      if (this.loadHistory) this.loadHistory();
    }
  }

  shopSalesWords(n) { const k = Math.max(0, Math.round(Number(n) || 0)); return k === 1 ? '1 sale' : this.group(k) + ' sales'; }

  /* The transaction screen's SALES, for a collection's row (26-render-history-and-contacts.js `renderTxDetail`). */
  shopTxVals(tx) {
    const d = tx && tx.shop && typeof tx.shop === 'object' ? tx.shop : null;
    const none = { txShopShown: false, txShopLine: '', txShopPaidShown: false, txShopPaid: '', txShopOrders: [], txShopMoreShown: false, txShopMore: '', txShopCopy: () => {} };
    if (!d) return none;
    const unit = d.unit || tx.unit || 'sat';
    const money = (n) => (unit === 'sat' ? '₿ ' + this.group(n) : this.unitMoney(n, unit));
    // "order,amount,i.j;" an order (08g-shop-collect.js `shopRowFold`)
    const orders = String(d.list || '').split(';').filter(Boolean).map((x) => {
      const f = x.split(',');
      return [f[0], Number(f[1]) || 0, f[2] ? f[2].split('.').map(Number) : []];
    });
    const ids = Array.isArray(d.ids) ? d.ids : [];
    const SHOWN = 200;
    return {
      txShopShown: true,
      txShopLine: d.name + ' (' + d.host + ') · ' + this.tillExpiresText(d.at) + ' · ' + this.shopSalesWords(d.n) + ', ' + money(d.total)
        + (orders.length ? '' : '. The list of orders was let go after ninety days.'),
      txShopPaidShown: ids.length > 0,
      txShopPaid: ids.length ? 'Shares paid to ' + ids.map((x) => x[1]).join(', ') : '',
      txShopOrders: orders.slice(0, SHOWN).map((o) => ({ order: String(o[0]), amount: money(Number(o[1]) || 0) })),
      txShopMoreShown: orders.length > SHOWN,
      txShopMore: orders.length > SHOWN ? 'and ' + this.group(orders.length - SHOWN) + ' more: COPY ORDERS has them all' : '',
      txShopCopy: () => {
        const lines = ['order,amount,unit,shares paid to'].concat(orders.map((o) => [o[0], o[1], unit,
          (Array.isArray(o[2]) ? o[2] : []).map((i) => (ids[i] ? ids[i][1] : '')).join(' ')].join(',')));
        this.toast(this.copyText(lines.join('\n')) ? 'Orders copied' : 'Could not copy');
      },
    };
  }
