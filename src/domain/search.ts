/**
 * Search over everything the journal recorded, served from the search projection the service keeps in SQLite.
 */
import * as Domain from "@alchemy.run/domain";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SearchHit = Schema.Struct({
  kind: Schema.String,
  id: Schema.String,
  title: Schema.String,
  snippet: Schema.String,
  app: Schema.NullOr(Schema.String),
  environment: Schema.NullOr(Schema.String),
  state: Schema.NullOr(Schema.String),
  at: Schema.Number,
});
export type SearchHit = typeof SearchHit.Type;

/** The port the Search query reads. The service implements it over SQLite; tests use memory. */
export class SearchStore extends Context.Service<SearchStore, {
  readonly search: (text: string, limit: number) => Effect.Effect<ReadonlyArray<SearchHit>>;
}>()("Overwatch/SearchStore") {}

export class Search extends Domain.Query("Search", {
  input: { text: Schema.String, limit: Schema.optionalKey(Schema.Number) },
  success: Schema.Array(SearchHit),
}, { description: "Search incidents, findings, prompts and threads, archived ones included. Exact ids match too." }) {}

export const SearchLive = Search.toLayer(
  Effect.gen(function* () {
    const store = yield* SearchStore;
    return Effect.fn(function* ({ text, limit }) {
      return yield* store.search(text, Math.min(100, Math.max(1, limit ?? 20)));
    });
  }),
);
