/**
 * Durak (2-player) — pure engine, no dependencies.
 * Deck: 36 cards (6–A, four suits). Deal 6 each; trump from bottom of stock.
 *
 * Podkidnoy: attacker may add cards whose rank already appears on the table,
 * including after partial defenses. If the defender runs out of cards while some
 * attacks are still open, they cannot add more attacks until the bout resolves:
 * defender may take(), or the attacker may endTurn(): defended pairs go to the
 * discard, undefeated attacks return to the attacker’s hand, roles swap, then draw.
 */

const SUITS = ["S", "H", "D", "C"];
const RANKS = ["6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const RANK_ORDER = Object.fromEntries(RANKS.map((r, i) => [r, i]));

function parseCard(card) {
  const m = String(card).match(/^(.+)([SHDC])$/i);
  if (!m) throw new Error(`Invalid card: ${card}`);
  const rank = m[1].toUpperCase() === "T" ? "10" : m[1];
  const suit = m[2].toUpperCase();
  if (!RANK_ORDER.hasOwnProperty(rank) || !SUITS.includes(suit))
    throw new Error(`Invalid card: ${card}`);
  return { rank, suit };
}

function formatCard(rank, suit) {
  return `${rank}${suit}`;
}

function buildDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push(formatCard(r, s));
  return deck;
}

function shuffle(array, rng = Math.random) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cloneState(s) {
  return {
    deck: s.deck.slice(),
    hands: s.hands.map((h) => h.slice()),
    trumpSuit: s.trumpSuit,
    attacker: s.attacker,
    defender: s.defender,
    table: s.table.map((row) => ({ attack: row.attack, defend: row.defend })),
    discard: s.discard.slice(),
    phase: s.phase,
    winner: s.winner,
    loser: s.loser,
  };
}

function ranksOnTable(table) {
  const set = new Set();
  for (const row of table) {
    set.add(parseCard(row.attack).rank);
    if (row.defend) set.add(parseCard(row.defend).rank);
  }
  return set;
}

function canBeat(attackCard, defendCard, trumpSuit) {
  const a = parseCard(attackCard);
  const d = parseCard(defendCard);
  const ta = a.suit === trumpSuit;
  const td = d.suit === trumpSuit;
  if (d.suit === a.suit && !ta && !td)
    return RANK_ORDER[d.rank] > RANK_ORDER[a.rank];
  if (!ta && td) return true;
  if (ta && td) return RANK_ORDER[d.rank] > RANK_ORDER[a.rank];
  return false;
}

function removeCardFromHand(hand, card) {
  const i = hand.indexOf(card);
  if (i === -1) throw new Error(`Card not in hand: ${card}`);
  const next = hand.slice();
  next.splice(i, 1);
  return next;
}

function drawUpToSix(state) {
  const s = cloneState(state);
  const order = [s.attacker, s.defender];
  for (const pi of order) {
    while (s.hands[pi].length < 6 && s.deck.length > 0) {
      s.hands[pi].push(s.deck.shift());
    }
  }
  return s;
}

function checkGameOver(state) {
  if (state.winner != null) return state;
  const s = cloneState(state);
  const [h0, h1] = s.hands;
  if (s.deck.length === 0) {
    if (h0.length === 0 && h1.length > 0) {
      s.winner = 0;
      s.loser = 1;
    } else if (h1.length === 0 && h0.length > 0) {
      s.winner = 1;
      s.loser = 0;
    } else if (h0.length === 0 && h1.length === 0) {
      s.winner = null;
      s.loser = null;
    }
  }
  return s;
}

/** @param {{ rng?: () => number }} [opts] */
function createInitialState(opts = {}) {
  const rng = typeof opts.rng === "function" ? opts.rng : Math.random;
  const deck = shuffle(buildDeck(), rng);
  const hands = [[], []];
  for (let i = 0; i < 6; i++) hands[0].push(deck.shift());
  for (let i = 0; i < 6; i++) hands[1].push(deck.shift());
  // deck[0] = next draw; bottom card defines trump until drawn
  const trumpSuit = parseCard(deck[deck.length - 1]).suit;
  const firstAttacker = Math.floor(rng() * 2);
  const defender = 1 - firstAttacker;
  return {
    deck,
    hands,
    trumpSuit,
    attacker: firstAttacker,
    defender,
    table: [],
    discard: [],
    phase: "attack",
    winner: null,
    loser: null,
  };
}

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {string} card
 */
function attack(state, card) {
  if (state.winner != null) throw new Error("Game is over");
  if (state.phase !== "attack" && state.phase !== "defend")
    throw new Error("Not in attack phase");
  const s = cloneState(state);
  const hand = s.hands[s.attacker];
  if (!hand.includes(card)) throw new Error("Attacker does not hold this card");

  if (s.table.length === 0) {
    s.hands[s.attacker] = removeCardFromHand(hand, card);
    s.table.push({ attack: card, defend: null });
    return checkGameOver(s);
  }

  const allowed = ranksOnTable(s.table);
  const r = parseCard(card).rank;
  if (!allowed.has(r)) throw new Error("Attack rank must appear on the table");

  const openRows = s.table.filter((t) => t.defend == null).length;
  const defLen = s.hands[s.defender].length;
  if (defLen === 0 && openRows > 0)
    throw new Error(
      "Defender is out of cards — finish the bout (take or end attack).",
    );

  s.hands[s.attacker] = removeCardFromHand(hand, card);
  s.table.push({ attack: card, defend: null });
  return checkGameOver(s);
}

/**
 * @param {ReturnType<typeof createInitialState>} state
 * @param {string} card
 * @param {string} against attack card to beat
 */
function defend(state, card, against) {
  if (state.winner != null) throw new Error("Game is over");
  if (state.phase !== "attack" && state.phase !== "defend")
    throw new Error("Cannot defend now");

  const s = cloneState(state);
  const row = s.table.find((t) => t.attack === against && t.defend == null);
  if (!row) throw new Error("No open attack matching `against`");

  const hand = s.hands[s.defender];
  if (!hand.includes(card)) throw new Error("Defender does not hold this card");
  if (!canBeat(against, card, s.trumpSuit))
    throw new Error("Illegal defense for this attack");

  s.hands[s.defender] = removeCardFromHand(hand, card);
  row.defend = card;
  s.phase = "defend";

  return checkGameOver(s);
}

/**
 * Defender transfers attack by adding same-rank card; roles swap for this bout.
 * @param {ReturnType<typeof createInitialState>} state
 * @param {string} card
 * @param {string} against open attack card with matching rank
 */
function transfer(state, card, against) {
  if (state.winner != null) throw new Error("Game is over");
  if (state.phase !== "attack") throw new Error("Cannot transfer now");
  if (state.table.length === 0) throw new Error("Nothing to transfer");
  if (state.table.some((t) => t.defend != null))
    throw new Error("Cannot transfer after any defense card is played");

  const s = cloneState(state);
  const row = s.table.find((t) => t.attack === against && t.defend == null);
  if (!row) throw new Error("No open attack matching `against`");

  const transferRank = parseCard(card).rank;
  const againstRank = parseCard(against).rank;
  if (transferRank !== againstRank)
    throw new Error("Transfer card rank must match attacked card rank");

  const defenderHand = s.hands[s.defender];
  if (!defenderHand.includes(card)) throw new Error("Defender does not hold this card");
  s.hands[s.defender] = removeCardFromHand(defenderHand, card);
  s.table.push({ attack: card, defend: null });

  const prevA = s.attacker;
  s.attacker = s.defender;
  s.defender = prevA;
  s.phase = "attack";
  return checkGameOver(s);
}

/**
 * Defender takes all cards on the table into hand; same attacker attacks again.
 * @param {ReturnType<typeof createInitialState>} state
 */
function take(state) {
  if (state.winner != null) throw new Error("Game is over");
  if (state.table.length === 0) throw new Error("Nothing to take");

  const s = cloneState(state);
  const taken = [];
  for (const row of s.table) {
    taken.push(row.attack);
    if (row.defend) taken.push(row.defend);
  }
  s.hands[s.defender] = s.hands[s.defender].concat(taken);
  s.table = [];
  s.phase = "attack";

  let next = drawUpToSix(s);
  next = checkGameOver(next);
  return next;
}

/**
 * Defender emptied hand while some attacks stayed open: discard defended pairs,
 * put undefeated attacks back on attacker, swap roles, draw (successful defense).
 * @param {ReturnType<typeof createInitialState>} state
 */
function endTurnPartialDefense(state) {
  const s = cloneState(state);
  const back = [];
  for (const row of s.table) {
    if (row.defend != null) {
      s.discard.push(row.attack, row.defend);
    } else {
      back.push(row.attack);
    }
  }
  s.hands[s.attacker] = s.hands[s.attacker].concat(back);
  s.table = [];
  const prevA = s.attacker;
  const prevD = s.defender;
  s.attacker = prevD;
  s.defender = prevA;
  s.phase = "attack";

  let next = drawUpToSix(s);
  next = checkGameOver(next);
  return next;
}

/**
 * After full defense (all rows covered), or partial defense with defender hand
 * empty: discard / return cards as appropriate, draw, defender becomes attacker.
 * @param {ReturnType<typeof createInitialState>} state
 */
function endTurn(state) {
  if (state.winner != null) throw new Error("Game is over");
  if (state.table.length === 0) throw new Error("Table is empty");
  const pending = state.table.some((t) => t.defend == null);
  if (pending) {
    if (state.hands[state.defender].length > 0)
      throw new Error("All attacks must be defended before ending turn");
    return endTurnPartialDefense(state);
  }

  const s = cloneState(state);
  for (const row of s.table) {
    s.discard.push(row.attack, row.defend);
  }
  s.table = [];
  const prevA = s.attacker;
  const prevD = s.defender;
  s.attacker = prevD;
  s.defender = prevA;
  s.phase = "attack";

  let next = drawUpToSix(s);
  next = checkGameOver(next);
  return next;
}

/**
 * Read-only snapshot for tests / inspection.
 * @param {ReturnType<typeof createInitialState>} state
 */
function getState(state) {
  return JSON.parse(JSON.stringify(state));
}

/**
 * Stateful wrapper: methods call pure reducers and replace internal state.
 * @param {Parameters<typeof createInitialState>[0]} [opts]
 */
function createGame(opts) {
  let state = createInitialState(opts);
  return {
    attack(card) {
      state = attack(state, card);
      return this;
    },
    defend(card, against) {
      state = defend(state, card, against);
      return this;
    },
    transfer(card, against) {
      state = transfer(state, card, against);
      return this;
    },
    take() {
      state = take(state);
      return this;
    },
    endTurn() {
      state = endTurn(state);
      return this;
    },
    getState() {
      return getState(state);
    },
    _raw() {
      return state;
    },
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    createInitialState,
    createGame,
    attack,
    defend,
    transfer,
    take,
    endTurn,
    getState,
    canBeat,
    parseCard,
    SUITS,
    RANKS,
  };
}
