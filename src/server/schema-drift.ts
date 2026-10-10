/**
 * Compile-time checks that the shared API schemas in types.ts match the review
 * core's own types. Lives apart from types.ts so the web bundle never pulls in
 * core modules, even for type checking.
 */
import type { ReviewEvent, ReviewStage as CoreReviewStage } from "../review/core/pipeline.ts";
import type { ReviewModelStage } from "../review/options.ts";
import type { CoreEvent, ReviewStage, StartRunRequest } from "./types.ts";

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;

export type SchemaDriftChecks = [
  Assert<Equals<ReviewStage, CoreReviewStage>>,
  // executeRun turns the core's `units` event into the run manager's `groups` event.
  Assert<Equals<CoreEvent, Exclude<ReviewEvent, { type: "units" }>>>,
  Assert<Equals<keyof NonNullable<StartRunRequest["models"]>, ReviewModelStage>>,
];
