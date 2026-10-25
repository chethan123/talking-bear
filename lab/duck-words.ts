// The 20 words of the X-F4 duck listening test (duck plan §5 T117): short, concrete nouns a 4–8-year-old knows,
// each with a picture (an emoji), so a speaker who can't read yet can say it too. lab/duck shows the speaker one at
// a time; the listener never sees the screen.

/** One test word and the emoji shown with it. */
export interface DuckWord {
  readonly word: string;
  readonly picture: string;
}

export const DUCK_WORDS: readonly DuckWord[] = Object.freeze([
  { word: 'cat', picture: '🐱' },
  { word: 'dog', picture: '🐶' },
  { word: 'ball', picture: '⚽' },
  { word: 'fish', picture: '🐟' },
  { word: 'car', picture: '🚗' },
  { word: 'cup', picture: '☕' },
  { word: 'hat', picture: '🎩' },
  { word: 'sun', picture: '☀️' },
  { word: 'moon', picture: '🌙' },
  { word: 'tree', picture: '🌳' },
  { word: 'shoe', picture: '👟' },
  { word: 'bus', picture: '🚌' },
  { word: 'egg', picture: '🥚' },
  { word: 'book', picture: '📖' },
  { word: 'duck', picture: '🦆' },
  { word: 'cake', picture: '🎂' },
  { word: 'bed', picture: '🛏️' },
  { word: 'boat', picture: '⛵' },
  { word: 'frog', picture: '🐸' },
  { word: 'star', picture: '⭐' },
]);
