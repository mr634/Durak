Place PNG files here. Served at /assets/cards/<filename>.

Required
  card_back.png          — face-down backs (deck, opponent). Referenced from HTML data-card-back-src.

Face cards (36-card Durak deck)
  The client tries several filename patterns per card until one loads:

  A) One image per card (recommended; lowercase words):
     {rank}_{suit}.png
     Ranks: six seven eight nine ten jack queen king ace
     Suits: hearts diamonds spades clubs
     Examples: ace_hearts.png  king_spades.png  ten_clubs.png

  B) One image per rank for red pair / black pair:
     {rank}_hearts_diamonds.png
     {rank}_spades_clubs.png
     Examples: nine_hearts_diamonds.png  eight_spades_clubs.png

  C) Legacy shared court art (optional):
     ace_hearts_diamonds.png   ace_spades_clubs.png
     jack_hearts_diamonds.png  jack_spades_clubs.png
     queen_hearts_diamonds.png queen_spades_clubs.png
     king_hearts_diamonds.png  king_spades_clubs.png
     nonface_hearts_diamonds.png  nonface_spades_clubs.png   (ranks 6–10)

Rank + suit are always drawn in the corners on top of the PNG.

If every candidate 404s, the UI falls back to text-only corners (no image).
