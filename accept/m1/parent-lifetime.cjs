// Only fixture services have this IPC channel. A killed test cannot call x.stop().
if (process.env.OW_TEST_FD && process.channel) {
  process.once("disconnect", () => process.kill(process.pid, "SIGTERM"))
}
