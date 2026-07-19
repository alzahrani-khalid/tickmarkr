// v1.51 T2 / gate hermeticity: TICKMARKR_QUALITY and TICKMARKR_NO_EXPLORE are legacy routing env
// vars that --quality no longer sets (v1.51 T2 made it a pure --mode partner-led alias with no floor
// raise of its own). An ambient value inherited from the operator's shell would still perturb
// unit-test routing, so seal both before any test collects — green in a clean pane shell, red at the
// gate otherwise. Constants are imported (not hardcoded) so a rename can't silently un-seal this.
// Runtime entrypoints also delete QUALITY_ENV; this setup guard keeps direct route() unit tests hermetic.
import { NO_EXPLORE_ENV, QUALITY_ENV } from "../src/route/router.js";

for (const k of [QUALITY_ENV, NO_EXPLORE_ENV]) delete process.env[k];
