// FOGSITE — card faces drawn entirely in code (CSS + inline SVG), styled after
// the physical Arclight edition: action cards are mottled green with a dark-
// magenta silhouette illustration over a parchment rule box; character cards
// are aged map-paper with a black vertical name banner and a dark hatted
// silhouette. No scanned assets are embedded — everything is hand-drawn markup,
// so the repo stays free of copyrighted art.
import { ACTION, RULES } from './rules.js';

// ---------------------------------------------------------------------------
// Action cards (警戒 / 休憩)
// ---------------------------------------------------------------------------
const ACTION_FACES = {
  [ACTION.CAUTION]: {
    title: '警戒', kana: 'ケイカイ', en: 'CAUTION',
    rule: '若被卫兵攻击，该攻击失败。<br>但若整轮未被攻击，将被贴上「禁止警戒牌」。',
    // a crouched, alert figure in a wide-brim hat, arm thrown up
    art: `<g fill="var(--card-art)">
      <ellipse cx="44" cy="22" rx="17" ry="4.5"/>
      <path d="M37 21 q1 -10 7 -10 q6 0 7 10 z"/>
      <path d="M35 27 q9 -5 17 0 l3 9 q9 3 11 12 l2 16 -8 0 -2 -12 -5 -3 1 15 -22 0 1 -14 -6 -8 z"/>
      <path d="M56 33 l13 -11 3 3.4 -12 12 z"/>
      <path d="M70 19 l5 -7 2.4 1.7 -4.4 7.6 z"/>
    </g>`,
  },
  [ACTION.REST]: {
    title: '休憩', kana: 'キュウケイ', en: 'REST',
    rule: `认为不会被攻击时，安心倒扣此卡。<br>若仍被攻击，损失 ${RULES.attackTileLoss} 块迷宫地块。`,
    // a camp at rest: bedroll, pack and a lit lantern
    art: `<g fill="var(--card-art)">
      <path d="M12 58 q34 -8 70 0 l0 7 -70 0 z"/>
      <path d="M20 54 q3 -17 16 -17 q13 0 15 17 z"/>
      <rect x="58" y="39" width="13" height="16" rx="2"/>
      <path d="M60 39 q4.5 -8 9 0" fill="none" stroke="var(--card-art)" stroke-width="2.6"/>
      <circle cx="64.5" cy="47" r="2.8" fill="var(--card-glow)"/>
      <path d="M38 33 q5 -7 10 -2 l-3.5 7 z"/>
    </g>`,
  },
};

// One face of a prediction card. opts: { act, disabled, stamp, stampCls }.
// When `act` is set (and not disabled) the whole card is a click target that
// the existing [data-act] delegation in ui.js picks up.
export function actionCardHtml(card, opts = {}) {
  const f = ACTION_FACES[card];
  if (!f) return '';
  const clickable = opts.act && !opts.disabled;
  const attrs = clickable ? ` data-act="${opts.act}" data-card="${card}" role="button" tabindex="0"` : '';
  const stamp = opts.stamp ? `<span class="ac-stamp ${opts.stampCls || ''}">${opts.stamp}</span>` : '';
  return `<div class="acard${opts.disabled ? ' off' : ''}${clickable ? ' pick' : ''}"${attrs}>
    <div class="ac-banner"><span class="orn">❖</span><b>${f.title}</b><i>${f.kana}</i><span class="orn">❖</span></div>
    <div class="ac-art"><svg viewBox="0 0 92 72" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${f.art}</svg></div>
    <div class="ac-rule">${f.rule}</div>
    ${stamp}
  </div>`;
}

// Face-down card back: dark leather with a compass rose, like the box art.
export function actionCardBackHtml(opts = {}) {
  const stamp = opts.stamp ? `<span class="ac-stamp ${opts.stampCls || ''}">${opts.stamp}</span>` : '';
  return `<div class="acard back">
    <svg viewBox="0 0 92 130" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <g stroke="var(--card-back-ink)" fill="none" stroke-width="1.4">
        <circle cx="46" cy="56" r="26"/><circle cx="46" cy="56" r="20"/>
        <path d="M46 32 L51 51 L70 56 L51 61 L46 80 L41 61 L22 56 L41 51 Z"
          fill="var(--card-back-ink)" stroke="none" opacity=".85"/>
        <path d="M46 24 v-8 M46 88 v8 M14 56 h-6 M78 56 h6"/>
      </g>
      <text x="46" y="112" text-anchor="middle" fill="var(--card-back-ink)"
        font-family="Georgia, serif" font-size="11" letter-spacing="3">FOGSITE</text>
    </svg>
    ${stamp}
  </div>`;
}

// ---------------------------------------------------------------------------
// Character cards
// ---------------------------------------------------------------------------
// Shared hatted-figure silhouette, in the spirit of the originals.
const BUST = `<g fill="var(--cc-sil)">
  <ellipse cx="50" cy="33" rx="31" ry="6"/>
  <path d="M36 32 q0 -19 14 -19 q14 0 14 19 z"/>
  <path d="M42 37 q0 12 8 14 q8 -2 8 -14 z"/>
  <path d="M50 50 q-21 4 -27 19 l-4 41 62 0 -4 -41 q-6 -15 -27 -19 z"/>
</g>`;

// Small line-art ability emblems (24x24), one per character.
const EMBLEMS = {
  archaeologist: `<g stroke="var(--cc-ink)" stroke-width="2" fill="none">
    <path d="M5 8 h14 M5 13 h14 M5 18 h14 M12 8 v5 M8.5 13 v5 M15.5 13 v5"/></g>`,
  guide: `<g stroke="var(--cc-ink)" stroke-width="1.8" fill="none">
    <circle cx="12" cy="12" r="8.5"/>
    <path d="M12 5.5 l2.4 6.5 -2.4 6.5 -2.4 -6.5 z" fill="var(--cc-ink)" stroke="none"/></g>`,
  monk: `<g stroke="var(--cc-ink)" stroke-width="2" fill="none">
    <path d="M12 5 v15 M12 5 l-4.5 4.5 M12 5 l4.5 4.5"/>
    <circle cx="7" cy="10" r="1.7"/><circle cx="17" cy="10" r="1.7"/></g>`,
  geographer: `<g stroke="var(--cc-ink)" stroke-width="1.7" fill="none">
    <path d="M4 7 l5.5 -2.2 5 2.2 5.5 -2.2 v13.5 l-5.5 2.2 -5 -2.2 -5.5 2.2 z M9.5 4.8 v13.5 M14.5 7 v13.5"/></g>`,
  mercenary: `<g stroke="var(--cc-ink)" stroke-width="2" fill="none">
    <path d="M8 16.5 L18 5 M6.5 13 l5.5 5.5 M10 19.5 l-3.5 3.5"/></g>`,
  doctor: `<g fill="var(--cc-ink)">
    <path d="M10.4 5 h3.2 v5.4 H19 v3.2 h-5.4 V19 h-3.2 v-5.4 H5 v-3.2 h5.4 z"/></g>`,
  apprentice: `<g stroke="var(--cc-ink)" stroke-width="1.7" fill="none">
    <path d="M12 7.2 q-4 -3.2 -8 -1.6 V19 q4 -1.6 8 1.2 q4 -2.8 8 -1.2 V5.6 q-4 -1.6 -8 1.6 z M12 7.2 V20.2"/></g>`,
};

// A full character card. `color` (optional) pins a seat ribbon on the corner.
export function charCardHtml(char, color) {
  if (!char) return '';
  return `<div class="charcard">
    <div class="cc-name">${char.name}</div>
    <i class="cc-en">${String(char.en).toUpperCase()}</i>
    ${color ? `<span class="cc-seat ${color}"></span>` : ''}
    <div class="cc-art"><svg viewBox="0 0 100 112" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${BUST}</svg></div>
    <div class="cc-foot">
      <span class="cc-badge"><svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">${EMBLEMS[char.id] || ''}</svg></span>
      <span class="cc-desc">${char.desc}</span>
    </div>
  </div>`;
}
