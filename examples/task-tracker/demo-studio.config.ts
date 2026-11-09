// Task Tracker is a fictional app: this example passes `validate` and `scenario-check`, but cannot be played.
import type { DemoStudioConfigInput } from 'demo-studio';

export default {
    baseUrl: 'http://tracker.localhost:3000',
    branding: {
        productName: 'Task Tracker',
        primaryColor: '#7c3aed',
        fontFamily: 'Inter, Arial, sans-serif',
        fontUrl: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=block',
    },
    browser: {
        timezone: 'Europe/London',
        hideSelectors: ['#dev-toolbar', '.cookie-banner'],
    },
    login: {
        url: '/login',
        fields: [
            { target: { label: 'Email' }, value: { account: 'email' } },
            { target: { label: 'Password' }, value: { env: 'TRACKER_DEMO_PASSWORD' } },
        ],
        submit: { role: 'button', name: 'Sign in' },
        after: [{ click: { role: 'button', name: 'Accept the terms' }, optional: true }],
    },
    accounts: [
        { id: 'manager', values: { email: 'maya.manager@tracker.test' } },
        { id: 'member', values: { email: 'ada.member@tracker.test' } },
        { id: 'visitor', login: 'none' },
    ],
    // Reads the lookups as JSON on stdin and prints `{ "<lookup>": <id> }`: see "Resolving lookups" in the README.
    resolve: { command: 'npm run --silent demo:resolve' },
    reset: { command: 'npm run --silent db:seed' },
} satisfies DemoStudioConfigInput;
