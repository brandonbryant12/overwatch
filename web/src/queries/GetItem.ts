/** An item in full. `seq` is the snapshot it is read against, so every newer commit reads it again. */
import { Query } from "@effect/ui";
import { Effect, Schema } from "effect";
import { ItemDetail, RequestFailed } from "../domain/Overwatch.ts";
import { Overwatch } from "../services/Overwatch.ts";
import { ItemsTag } from "./tags.ts";

export class GetItem extends Query.Service<GetItem>()("overwatch/GetItem", {
  args: { id: Schema.String, seq: Schema.Number },
  success: ItemDetail,
  error: RequestFailed,
  staleTime: 0,
  tags: [ItemsTag],
}) {
  static readonly layer = this.toLayer(
    Effect.gen(function* () {
      const api = yield* Overwatch;
      return ({ id }) => api.item(id);
    }),
  );
}
