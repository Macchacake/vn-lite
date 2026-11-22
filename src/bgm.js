// ============================================
// bgm.js — WebAudio 程序化氛围音乐（零音频文件）
// 情绪 → 和弦 pad，切换交叉淡出；首次用户点击解锁。
// ============================================

const MOOD_CHORDS = {
    '平静':   { freqs: [220.0, 277.18, 329.63], type: 'sine',     cut: 900,  lfo: 0.08, gain: 0.6 },
    '欢快':   { freqs: [261.63, 329.63, 392.0, 493.88], type: 'triangle', cut: 1600, lfo: 0.5,  gain: 0.5 },
    '紧张':   { freqs: [110.0, 116.54, 138.59], type: 'sawtooth', cut: 420,  lfo: 2.2,  gain: 0.35 },
    '悲伤':   { freqs: [196.0, 233.08, 293.66], type: 'sine',     cut: 700,  lfo: 0.05, gain: 0.5 },
    '温馨':   { freqs: [246.94, 311.13, 369.99], type: 'triangle', cut: 1100, lfo: 0.12, gain: 0.55 },
    '神秘':   { freqs: [164.81, 196.0, 246.94], type: 'sine',     cut: 600,  lfo: 0.3,  gain: 0.5 },
};

class BGM {
    constructor() {
        this.ctx = null;
        this.master = null;
        this.current = null;   // {oscs, gains, lfo}
        this.mood = null;
        this.volume = 0.3;
        this.enabled = false;
        this._unlocked = false;
    }

    // 浏览器自动播放策略：首次任意点击解锁
    attachUnlock() {
        const unlock = () => {
            if (this._unlocked) return;
            this._unlocked = true;
            if (this.enabled && this.mood) this._play(this.mood, true);
        };
        document.addEventListener('click', unlock, { once: true, capture: true });
        document.addEventListener('touchstart', unlock, { once: true, capture: true });
    }

    setEnabled(on) {
        this.enabled = !!on;
        if (!on) this.stop();
        else if (this.mood) this._play(this.mood);
    }

    setVolume(v) {
        this.volume = Math.max(0, Math.min(1, v));
        if (this.master) {
            this.master.gain.setTargetAtTime(this.volume * 0.55, this.ctx.currentTime, 0.2);
        }
    }

    setMood(mood) {
        if (!this.enabled || !MOOD_CHORDS[mood] || mood === this.mood) {
            if (MOOD_CHORDS[mood]) this.mood = mood;
            return;
        }
        this.mood = mood;
        if (!this._unlocked) return; // 等点击解锁后自然会响
        this._play(mood);
    }

    _ensureCtx() {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) return null;
            this.ctx = new AC();
            this.master = this.ctx.createGain();
            this.master.gain.value = this.volume * 0.55;
            this.master.connect(this.ctx.destination);
        }
        if (this.ctx.state === 'suspended') this.ctx.resume();
        return this.ctx;
    }

    _play(mood, skipFadeIn) {
        const ctx = this._ensureCtx();
        if (!ctx) return;
        this._stopCurrent(0.8);
        const def = MOOD_CHORDS[mood];
        const t = ctx.currentTime;
        const gains = [], oscs = [];
        const group = { oscs, gains, lfoGain: null };
        for (let i = 0; i < def.freqs.length; i++) {
            const osc = ctx.createOscillator();
            osc.type = def.type;
            osc.frequency.value = def.freqs[i];
            osc.detune.value = (i - def.freqs.length / 2) * 4; // 轻微失谐更柔
            const g = ctx.createGain();
            g.gain.value = 0;
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = def.cut;
            osc.connect(g); g.connect(lp); lp.connect(this.master);
            const target = def.gain / def.freqs.length;
            g.gain.setTargetAtTime(target, t, skipFadeIn ? 0.4 : 1.2);
            osc.start();
            oscs.push(osc); gains.push(g);
        }
        // 慢 LFO 让音量轻微起伏
        const lfo = ctx.createOscillator();
        lfo.frequency.value = def.lfo;
        const lfoGain = ctx.createGain();
        lfoGain.gain.value = 0.04;
        lfo.connect(lfoGain);
        gains.forEach(g => lfoGain.connect(g.gain));
        lfo.start();
        group.lfoGain = lfoGain;
        group.lfo = lfo;
        this.current = group;
    }

    _stopCurrent(fadeSec) {
        if (!this.current || !this.ctx) return;
        const t = this.ctx.currentTime;
        const { oscs, gains, lfo, lfoGain } = this.current;
        gains.forEach(g => g.gain.setTargetAtTime(0, t, fadeSec / 3));
        setTimeout(() => {
            oscs.forEach(o => { try { o.stop(); } catch { /* already stopped */ } });
            try { lfo.stop(); } catch { /* already stopped */ }
            try { lfoGain.disconnect(); } catch { /* noop */ }
        }, fadeSec * 1000 + 300);
        this.current = null;
    }

    stop() {
        this._stopCurrent(0.5);
        this.mood = null;
    }
}

const bgm = new BGM();
export { bgm, MOOD_CHORDS };
