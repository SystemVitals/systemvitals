import {
  ReconciliationLockUnavailableError,
  ReconciliationRunLock,
} from './subscription-reconciliation-lock';

function fixture(
  query = jest.fn().mockResolvedValue({
    rows: [{ acquired: true }],
  }),
) {
  const connect = jest.fn().mockResolvedValue(undefined);
  const end = jest.fn().mockResolvedValue(undefined);
  const createClient = jest.fn().mockReturnValue({ connect, query, end });
  const now = jest
    .fn()
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(5_100);
  const sleep = jest.fn().mockResolvedValue(undefined);
  const lock = new ReconciliationRunLock(createClient, now, sleep);
  return { lock, createClient, connect, query, end, now, sleep };
}

describe('ReconciliationRunLock', () => {
  it('uses the shared namespaced account key for a bounded user session lock', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
    const { lock, end } = fixture(query);

    await expect(
      lock.withUserLock('user-1', () => Promise.resolve('complete')),
    ).resolves.toBe('complete');

    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('pg_try_advisory_lock(hashtextextended'),
      ['systemvitals:account-lock:v1:user-1', '7431924617552913487'],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('pg_advisory_unlock(hashtextextended'),
      ['systemvitals:account-lock:v1:user-1', '7431924617552913487'],
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('bounds user-lock acquisition and closes without running the operation', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ acquired: false }] });
    const { lock, sleep, end } = fixture(query);
    const operation = jest.fn();

    await expect(lock.withUserLock('user-1', operation)).rejects.toEqual(
      new ReconciliationLockUnavailableError(),
    );

    expect(operation).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledWith(250);
    expect(query).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('uses a bounded try-lock and verifies unlock before closing', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
    const { lock, connect, end } = fixture(query);

    await expect(
      lock.withLock(() => Promise.resolve('complete')),
    ).resolves.toBe('complete');

    expect(connect).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenNthCalledWith(
      1,
      'SELECT pg_try_advisory_lock($1) AS acquired',
      [1_735_688_564],
    );
    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT pg_advisory_unlock($1) AS unlocked',
      [1_735_688_564],
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('polls with backoff and returns a sanitized bounded acquisition failure', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ acquired: false }] });
    const { lock, sleep, end } = fixture(query);

    await expect(lock.withLock(jest.fn())).rejects.toEqual(
      new ReconciliationLockUnavailableError(),
    );

    expect(sleep).toHaveBeenCalledWith(250);
    expect(query).toHaveBeenCalledTimes(2);
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('unlocks and closes when the run fails', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: true }] });
    const { lock, end } = fixture(query);
    const failure = new Error('run failed');

    await expect(lock.withLock(() => Promise.reject(failure))).rejects.toBe(
      failure,
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('closes the client when connect fails', async () => {
    const { lock, connect, query, end } = fixture();
    connect.mockRejectedValue(new Error('secret connection detail'));

    await expect(lock.withLock(jest.fn())).rejects.toThrow(
      'Reconciliation lock connection failed',
    );
    expect(query).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('closes the client when acquisition query fails', async () => {
    const { lock, query, end } = fixture();
    query.mockRejectedValue(new Error('secret query detail'));

    await expect(lock.withLock(jest.fn())).rejects.toThrow(
      'Reconciliation lock acquisition failed',
    );
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('rejects a false unlock result and still closes', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockResolvedValueOnce({ rows: [{ unlocked: false }] });
    const { lock, end } = fixture(query);

    await expect(
      lock.withLock(() => Promise.resolve('complete')),
    ).rejects.toThrow('Reconciliation lock release failed');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('closes when unlock query fails without exposing database details', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ acquired: true }] })
      .mockRejectedValueOnce(new Error('secret unlock detail'));
    const { lock, end } = fixture(query);

    await expect(
      lock.withLock(() => Promise.resolve('complete')),
    ).rejects.toThrow('Reconciliation lock release failed');
    expect(end).toHaveBeenCalledTimes(1);
  });

  it('reports close failure with a sanitized error', async () => {
    const { lock, end } = fixture();
    end.mockRejectedValue(new Error('secret close detail'));

    await expect(
      lock.withLock(() => Promise.resolve('complete')),
    ).rejects.toThrow('Reconciliation lock connection close failed');
  });
});
