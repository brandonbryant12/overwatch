/** What changed, from the event log, written for one audience. */
import { Query } from "@effect/ui";
import { Effect } from "effect";
import { Audience, Brief, RequestFailed } from "../domain/Overwatch.ts";
import { Overwatch } from "../services/Overwatch.ts";

export class GetBrief extends Query.Service<GetBrief>()("overwatch/GetBrief", {
  args: { audience: Audience },
  success: Brief,
  error: RequestFailed,
  staleTime: 0,
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return ({ audience }) => api.brief(audience);
    }),
  );
}
