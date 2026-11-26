/** Where a prompt on a subject goes, with a fresh request key: the page makes no identifiers. */
import { Query } from "@effect/ui";
import { Effect, Schema } from "effect";
import { Focus, RequestFailed } from "../domain/Overwatch.ts";
import { Overwatch } from "../services/Overwatch.ts";
import { FocusTag } from "./tags.ts";

export class GetFocus extends Query.Service<GetFocus>()("overwatch/GetFocus", {
  args: { subject: Schema.String },
  success: Focus,
  error: RequestFailed,
  staleTime: 0,
  tags: [FocusTag],
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return ({ subject }) => api.focus(subject);
    }),
  );
}
