// Cancel unfinished work when its response connection closes.
const abortWhenResponseCloses = (res) => {
  const controller = new AbortController();
  const onClose = () => {
    if (res.writableEnded || controller.signal.aborted) return;
    const error = new Error('Client disconnected');
    error.name = 'AbortError';
    controller.abort(error);
  };
  res.once('close', onClose);
  return { signal: controller.signal, dispose: () => res.off('close', onClose) };
};

module.exports = { abortWhenResponseCloses };
