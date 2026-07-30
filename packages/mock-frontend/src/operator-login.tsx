import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createSiweMessage } from 'viem/siwe';

import type { NonceResponse, SessionResponse, VerifyResponse } from '../../../contract/arena-types';
import { truncateAddress } from './feed-projection';

// EIP-1193, the only wallet surface this mock needs.
interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

/**
 * Wallet login against the arena's own /auth routes, so the SIWE path can be
 * clicked locally. Once signed in the dev proxy stops adding the operator token,
 * which means the buttons below are exercising the session cookie for real.
 */
export function OperatorLogin() {
  const cache = useQueryClient();
  const session = useQuery({
    queryKey: ['auth-session'],
    queryFn: async () => {
      const response = await fetch('/auth/session');
      return await response.json() as SessionResponse;
    },
  });

  const signIn = useMutation({
    mutationFn: async () => {
      const wallet = window.ethereum;
      if (wallet === undefined) throw new Error('No injected wallet found');
      const nonceResponse = await fetch('/auth/nonce');
      if (nonceResponse.status === 503) throw new Error('Wallet login is not configured on the backend');
      if (!nonceResponse.ok) throw new Error(`Nonce request failed with status ${nonceResponse.status}`);
      const { nonce } = await nonceResponse.json() as NonceResponse;

      const [address] = await wallet.request({ method: 'eth_requestAccounts' }) as string[];
      if (address === undefined) throw new Error('Wallet returned no account');
      const chainId = Number(await wallet.request({ method: 'eth_chainId' }));
      // The domain is what the wallet shows the operator, so it has to be this page.
      const message = createSiweMessage({
        address: address as `0x${string}`,
        chainId,
        domain: window.location.host,
        nonce,
        uri: window.location.origin,
        statement: 'Sign in to drive the agents arena.',
        version: '1',
      });
      const signature = await wallet.request({
        method: 'personal_sign',
        params: [message, address],
      }) as string;

      const verified = await fetch('/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      const body = await verified.json() as VerifyResponse | { error: string };
      if (!verified.ok) throw new Error('error' in body ? body.error : `Login failed with status ${verified.status}`);
      return body as VerifyResponse;
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: ['auth-session'] }),
  });

  const signOut = useMutation({
    mutationFn: async () => {
      await fetch('/auth/logout', { method: 'POST' });
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: ['auth-session'] }),
  });

  const current = session.data;
  const error = signIn.error instanceof Error ? signIn.error.message : null;

  // No allowlist on the backend means no wallet can sign in, so offer nothing.
  if (current !== undefined && !current.authenticated && !current.configured) return null;

  return (
    <div className="operator-login">
      {current?.authenticated === true ? (
        <>
          <span className="operator-address" title={current.address} data-testid="operator-address">
            {truncateAddress(current.address)}
          </span>
          <button
            className="btn ghost"
            disabled={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            sign out
          </button>
        </>
      ) : (
        <button
          className="btn ghost"
          disabled={signIn.isPending}
          onClick={() => signIn.mutate()}
          data-testid="sign-in"
        >
          {signIn.isPending ? 'signing…' : 'sign in with wallet'}
        </button>
      )}
      {error !== null ? <span className="operator-error" data-testid="login-error">{error}</span> : null}
    </div>
  );
}
