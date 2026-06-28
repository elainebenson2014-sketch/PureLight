19:14:19.143 Running build in Washington, D.C., USA (East) – iad1
19:14:19.144 Build machine configuration: 4 cores, 8 GB
19:14:19.243 Cloning github.com/elainebenson2014-sketch/PureLight (Branch: main, Commit: 95d8a1d)
19:14:19.459 Cloning completed: 215.000ms
19:14:19.596 Restored build cache from previous deployment (8Lscemw76Vvq75uBK3W326qZopKj)
19:14:19.803 Running "vercel build"
19:14:19.814 Vercel CLI 54.17.2
19:14:20.726 Installing dependencies...
19:14:24.272 
19:14:24.272 up to date in 3s
19:14:24.273 
19:14:24.273 7 packages are looking for funding
19:14:24.273   run `npm fund` for details
19:14:24.303 Running "npm run build"
19:14:24.392 
19:14:24.392 > ncts-purelight@1.0.0 build
19:14:24.392 > vite build
19:14:24.392 
19:14:24.596 vite v5.4.21 building for production...
19:14:24.649 transforming...
19:14:24.964 ✓ 21 modules transformed.
19:14:24.964 x Build failed in 341ms
19:14:24.965 error during build:
19:14:24.965 [vite:esbuild] Transform failed with 1 error:
19:14:24.965 /vercel/path0/src/ui.jsx:226:9: ERROR: Expected ")" but found "style"
19:14:24.965 file: /vercel/path0/src/ui.jsx:226:9
19:14:24.965 
19:14:24.965 Expected ")" but found "style"
19:14:24.965 224|        <main style={{ flex: 1, padding: "30px 38px", maxWidth: 1100 }}>{children}</main>
19:14:24.965 225|      </div>
19:14:24.965 226|      <div style={{
19:14:24.965    |           ^
19:14:24.965 227|        position: "fixed", bottom: 0, left: 0, width: 248,
19:14:24.966 228|        textAlign: "center", padding: "8px 12px",
19:14:24.966 
19:14:24.966     at failureErrorWithLog (/vercel/path0/node_modules/esbuild/lib/main.js:1472:15)
19:14:24.966     at /vercel/path0/node_modules/esbuild/lib/main.js:755:50
19:14:24.966     at responseCallbacks.<computed> (/vercel/path0/node_modules/esbuild/lib/main.js:622:9)
19:14:24.966     at handleIncomingPacket (/vercel/path0/node_modules/esbuild/lib/main.js:677:12)
19:14:24.966     at Socket.readFromStdout (/vercel/path0/node_modules/esbuild/lib/main.js:600:7)
19:14:24.966     at Socket.emit (node:events:509:28)
19:14:24.966     at addChunk (node:internal/streams/readable:563:12)
19:14:24.966     at readableAddChunkPushByteMode (node:internal/streams/readable:514:3)
19:14:24.966     at Readable.push (node:internal/streams/readable:394:5)
19:14:24.966     at Pipe.onStreamRead (node:internal/stream_base_commons:189:23)
19:14:24.996 Error: Command "npm run build" exited with 1
