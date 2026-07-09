/**
 * OpenTelemetry preload for `@mediator/backend`.
 *
 * This module is loaded via `node --import` (dev: `tsx watch --import ./src/otel.ts`;
 * prod: `node --import ./dist/otel.js dist/index.js`) so it runs BEFORE the app
 * and any instrumented libraries (fastify, pg, http) are imported — a hard
 * requirement for the OpenTelemetry auto-instrumentations to patch them.
 *
 * It loads the validated config and starts the SDK. When telemetry is disabled
 * (empty `OTEL_EXPORTER_OTLP_ENDPOINT`), `startTelemetry` is a clean no-op, so
 * this preload is safe to keep wired in every environment.
 */
import { loadConfig } from "@mediator/config";
import { startTelemetry } from "@mediator/telemetry";

import { loadRepoEnv } from "./env.js";

loadRepoEnv();
startTelemetry(loadConfig().telemetry);
