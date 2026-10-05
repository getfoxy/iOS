
  /* The frame every screen sits in: size, theme and accent, the keyboard, the toast,
   * the Tor warning, Back. */
  /** @param {RenderContext} c */
  renderShell(c) {
    const { s, sc } = c;
    return {
      shellRef: this.shellRef,
      staticAttr: this.props.startStatic ? '1' : '0',
      shellKbPad: (s.kbInset || 0) + 'px',
      theme: TH(this), isDarkTheme: TH(this) !== 'light',
      back: () => this.back(),
      kbPrimerRef: this._refPrimer || (this._refPrimer = (el) => { this._primerEl = el; }),
      wantFocus: !this.props.startStatic,
      showKb: !!this.props.startKeyboard,
      ctaInk: CTA_INK(s),
      accHex: ACC_OF(AC(this)).acc,
      accLt: ACC_OF(AC(this)).lt,
      accDk: ACC_OF(AC(this)).dk,
      accRgb: ACC_OF(AC(this)).rgb,
      stopTap: (e) => e.stopPropagation(),
      toastText: s.toastMsg || '',
      toastBg: s.toastAmber ? '#E0902E' : 'var(--acc)',
      toastShown: s.toastMsg ? '1' : '0',
      toastY: s.toastMsg ? '0%' : '-100%',
      /* The tunnel warning, rendered inline rather than pinned over the app.
       *
       * Read off the gate each render; __foxyGateChanged is what tells us a
       * render is due, since the gate lives outside the runtime. */
      gateWarnShown: !!(window.FoxyGate && window.FoxyGate.warning && window.FoxyGate.warning()),
      gateWarn: ((window.FoxyGate && window.FoxyGate.warning && window.FoxyGate.warning()) || {}).text || '',
      gateWarnBg: ((window.FoxyGate && window.FoxyGate.warning && window.FoxyGate.warning()) || {}).colour || '#8C1D1D',
      gateWarnTap: () => {
        const G = window.FoxyGate;
        if (G && G.rearm) G.rearm(() => this._gateThenBoot && this._gateThenBoot());
      },
    };
  }

  /* A payment's note: its button on the invoice and token screens, and its sheet. */
  /** @param {RenderContext} c */
  renderNote(c) {
    const { s } = c;
    return {
      noteInput: (e) => this.setState({ note: e.target.value.slice(0, 120) }),
      noteFocusRef: this._refNote || (this._refNote = (el) => this.autoFocus('note', el)),
      hasNote: !!this.noteShown(), noNote: !this.noteShown(),
      noteText: this.noteShown(),
      noteBtnBg: this.noteShown() ? 'var(--acc)' : 'var(--ink)',
      noteOpen: this.props.startPopup === 'noteOpen' || !!s.noteOpen,
      noteCount: (s.note || '').length,
      cancelNote: () => this.setState({ noteOpen: false, note: this.state.noteDraft || '' }),
      saveNote: () => this.setState({ noteOpen: false, note: (this.state.note || '').trim() }),
    };
  }
