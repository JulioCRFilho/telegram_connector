// Spawned by test.pids-race.js — simulates one wrapper's boot-time pid write.
// argv[2] is the instance name (lib/config reads INSTANCE_NAME from argv[2]).
const procs = require('./lib/procs');
procs.writePidEntry();