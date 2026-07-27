return [
  {
    json: {
      success: false,
      country: $json.country || '',
      action: $json.action || '',
      request_id: $json.request_id || '',
      data: null,
      error: {
        code: 'INVALID_REQUEST',
        message: (($json.errors || []).join('; ') || 'invalid request'),
      },
    },
  },
];
