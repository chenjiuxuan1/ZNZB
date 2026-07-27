const raw = $json;
const stdout = typeof raw.stdout === 'string' ? raw.stdout.trim() : '';
const stderr = typeof raw.stderr === 'string' ? raw.stderr.trim() : '';
const exitCode = raw.code;
const signal = raw.signal ?? null;

if (!stdout) {
  return [
    {
      json: {
        success: false,
        country: '',
        action: '',
        request_id: '',
        data: null,
        error: {
          code: 'EMPTY_STDOUT',
          message: stderr || 'command returned empty stdout',
          exit_code: exitCode,
          signal,
        },
      },
    },
  ];
}

try {
  const parsed = JSON.parse(stdout);
  return [{ json: parsed }];
} catch (error) {
  return [
    {
      json: {
        success: false,
        country: '',
        action: '',
        request_id: '',
        data: null,
        error: {
          code: 'INVALID_COMMAND_OUTPUT',
          message: String(error),
          exit_code: exitCode,
          signal,
          stderr,
          stdout,
        },
      },
    },
  ];
}
