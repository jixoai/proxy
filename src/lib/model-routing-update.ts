import { z } from "zod";
import { modelRoutingSchema } from "./provider-routing-config";

export const modelRoutingUpdateSchema = z
  .object({
    expected: modelRoutingSchema.nullable(),
    modelRouting: modelRoutingSchema.nullable(),
  })
  .strict();

export class ModelRoutingUpdateError extends Error {
  constructor(
    public readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
