// Voice agent worker. Registers with the LiveKit server and runs each call in its own job process
// (entrypoint: agent.ts). Start with: node dist/voice/worker.js start
import 'dotenv/config'; // must stay first — job processes inherit this environment
import { fileURLToPath } from 'node:url';
import { ServerOptions, cli } from '@livekit/agents';
import { getVoiceConfig } from './config.js';

const cfg = getVoiceConfig();

// The agents CLI resolves the server URL as `--url`/LIVEKIT_URL first, overriding `wsURL` below.
// In our env LIVEKIT_URL is the PUBLIC url handed to browsers; this worker (and the job processes
// it forks, which inherit this env) must use the internal loopback URL instead.
process.env.LIVEKIT_URL = cfg.internalUrl;

// The SDK preloads a local audio end-of-turn model (~250 MB RAM) whenever its native add-on is
// installed. We detect turns with Deepgram (turnDetection: 'stt'), so that model is never used —
// skip loading it to keep memory for the APIs on this small host.
process.env.LIVEKIT_AGENTS_PRELOAD_LOCAL_INFERENCE ??= 'false';

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(new URL('./agent.js', import.meta.url)),
    agentName: cfg.agentName, // explicit dispatch: joins only rooms that request this agent
    wsURL: cfg.internalUrl,
    apiKey: cfg.apiKey,
    apiSecret: cfg.apiSecret,
    // One warm process (VAD already loaded) so a new call starts instantly, without holding
    // spare memory on a small server.
    numIdleProcesses: 1,
    loadThreshold: 0.9,
    jobMemoryWarnMB: 400,
    host: '127.0.0.1', // health endpoint stays local
  }),
);
