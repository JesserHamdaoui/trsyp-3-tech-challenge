/** Games that exist in the app, keyed by the exercise they train. An exercise
 * without an entry here has no playable game yet. */
export interface GameEntry {
  exerciseId: string;
  title: string;
  /** admin practice run: plays normally, saves nothing */
  tryHref: string;
}

export const GAMES: GameEntry[] = [
  { exerciseId: "piano_isolated_press", title: "Piano Press", tryHref: "/admin/exercises/piano" },
  { exerciseId: "pinch_flight", title: "Pinch Flight", tryHref: "/admin/exercises/pinch" },
];

export const gameForExercise = (exerciseId: string) => GAMES.find((g) => g.exerciseId === exerciseId);
