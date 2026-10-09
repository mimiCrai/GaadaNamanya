import http from 'k6/http';
import { check, fail } from 'k6';

export function withoutTrailingSlash(value) {
    return value.replace(/\/$/, '');
}

export function registerSessions(authBaseUrl, count) {
    const sessions = [];

    for (let index = 0; index < count; index += 1) {
        const email = `k6-${Date.now()}-${index}-${Math.floor(Math.random() * 1_000_000)}@example.test`;
        const registration = http.post(
            `${authBaseUrl}/auth/register`,
            JSON.stringify({ email, password: 'correct horse battery staple' }),
            { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'auth-register' } }
        );

        if (!check(registration, { 'k6 user registered': (response) => response.status === 201 })) {
            fail(`Could not register load-test user: HTTP ${registration.status}`);
        }

        const accessToken = registration.json('data.accessToken');
        const refreshToken = registration.json('data.refreshToken');
        if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
            fail('Registration did not return an access and refresh token');
        }

        sessions.push({ accessToken, refreshToken });
    }

    return sessions;
}

export function refreshSession(authBaseUrl, refreshToken) {
    const response = http.post(
        `${authBaseUrl}/auth/refresh`,
        JSON.stringify({ refreshToken }),
        { headers: { 'Content-Type': 'application/json' }, tags: { endpoint: 'auth-refresh' } }
    );

    if (!check(response, { 'k6 session refreshed': (result) => result.status === 200 })) {
        fail(`Could not refresh load-test session: HTTP ${response.status}`);
    }

    const accessToken = response.json('data.accessToken');
    const nextRefreshToken = response.json('data.refreshToken');
    if (typeof accessToken !== 'string' || typeof nextRefreshToken !== 'string') {
        fail('Refresh did not return an access and refresh token');
    }

    return { accessToken, refreshToken: nextRefreshToken };
}
