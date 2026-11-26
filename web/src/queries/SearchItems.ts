/** Every match of a search, in pages of fifty: the next page is loaded on request, so each match can be reached. */
import { Query } from "@effect/ui";
import { Effect, Option, Schema } from "effect";
import { RequestFailed, SearchPage } from "../domain/Overwatch.ts";
import { Overwatch } from "../services/Overwatch.ts";

export class SearchItems extends Query.InfiniteService<SearchItems>()("overwatch/SearchItems", {
  args: { q: Schema.String },
  page: SearchPage,
  items: (page) => page.items,
  key: (hit) => hit.id,
  error: RequestFailed,
  cursor: Schema.String,
  next: (page) => Option.fromNullishOr(page.nextCursor),
  staleTime: 0,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return ({ q }, cursor) => api.search(q, cursor);
    }),
  );
}
