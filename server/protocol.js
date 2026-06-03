// FOGSITE — online wire protocol. Pure constants + shape validation for the
// messages a client may send to the authoritative room core. No I/O, no rules
// logic (the engine owns rules; this only rejects malformed input early).
import { COLORS, ACTION, DIR_KEYS } from '../src/rules.js';

// Action / message types a client can send.
export const TYPES = {
  JOIN: 'join',                   // claim a seat (guardian or an investigator color)
  CONFIGURE: 'configure',         // guardian sets maze + characters (lobby)
  START: 'start',                 // guardian starts the game (lobby)
  EXPLORE: 'explore',             // investigator turn action
  MOVE: 'move',                   // investigator turn action
  ABILITY: 'ability',             // investigator turn action
  PASS: 'pass',                   // investigator turn action
  ESCAPE_CONFIRM: 'escape_confirm', // investigator commits to the escape check
  ESCAPE_TIMEOUT: 'escape_timeout', // server/guardian: countdown expired
  PREDICT: 'predict',             // investigator secret 警戒/休憩
  GUARD_MOVE: 'guard_move',       // guardian turn action
  DEITY_MOVE: 'deity_move',       // guardian turn action
  ATTACK: 'attack',               // guardian turn action
  GUARD_END: 'guard_end',         // guardian ends their turn
};

const isColor = (v) => COLORS.includes(v);
const isDir = (v) => DIR_KEYS.includes(v);
const isCard = (v) => v === ACTION.CAUTION || v === ACTION.REST;

// Returns null if the action is well-formed, otherwise an error string. This is
// purely structural; legality within the game (turn, range, etc.) is decided by
// the room core + engine.
export function validateAction(action) {
  if (!action || typeof action !== 'object') return 'action must be an object';
  const t = action.type;
  if (typeof t !== 'string') return 'action.type must be a string';

  switch (t) {
    case TYPES.JOIN:
      if (action.role !== 'guardian' && action.role !== 'investigator') return 'join.role must be guardian|investigator';
      if (action.role === 'investigator' && !isColor(action.color)) return 'join.color must be red|green|blue';
      return null;

    case TYPES.CONFIGURE:
      if (action.count !== 2 && action.count !== 3) return 'configure.count must be 2 or 3';
      if (!action.maze || typeof action.maze !== 'object') return 'configure.maze required';
      if (!action.characters || typeof action.characters !== 'object') return 'configure.characters required';
      return null;

    case TYPES.START:
    case TYPES.PASS:
    case TYPES.ESCAPE_CONFIRM:
    case TYPES.ESCAPE_TIMEOUT:
    case TYPES.GUARD_END:
      return null; // no payload

    case TYPES.EXPLORE:
    case TYPES.MOVE:
    case TYPES.GUARD_MOVE:
      if (!isDir(action.dir)) return `${t}.dir must be N|E|S|W`;
      return null;

    case TYPES.DEITY_MOVE:
      if (!isDir(action.dir)) return 'deity_move.dir must be N|E|S|W';
      if (!isColor(action.targetColor)) return 'deity_move.targetColor must be red|green|blue';
      return null;

    case TYPES.ABILITY:
      // The engine validates ability params per character; here just shape-check.
      if (action.params !== undefined && (action.params === null || typeof action.params !== 'object')) {
        return 'ability.params must be an object';
      }
      return null;

    case TYPES.PREDICT:
      if (!isCard(action.card)) return 'predict.card must be caution|rest';
      return null;

    case TYPES.ATTACK:
      if (!isColor(action.color)) return 'attack.color must be red|green|blue';
      if (action.attacker !== 'guard' && action.attacker !== 'deity') return 'attack.attacker must be guard|deity';
      return null;

    default:
      return `unknown action type: ${t}`;
  }
}
