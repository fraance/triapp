// Google Calendar OAuth configuration
export const GOOGLE_CALENDAR_CONFIG = {
  CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
  CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI:
    process.env.GOOGLE_REDIRECT_URI ||
    "http://localhost:3000/api/google-calendar/callback",
  AUTH_URL: "https://accounts.google.com/o/oauth2/v2/auth",
  TOKEN_URL: "https://oauth2.googleapis.com/token",
  SCOPES: [
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/calendar.events",
  ],
};

// Mock calendar events for development/testing
export const MOCK_CALENDAR_EVENTS = [
  {
    id: "mock_1",
    summary: "Work Conference",
    start: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 days from now
    end: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
    description: "Annual company conference in San Francisco",
    location: "San Francisco, CA",
    allDay: false,
  },
  {
    id: "mock_2",
    summary: "Family Vacation",
    start: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days from now
    end: new Date(Date.now() + 21 * 24 * 60 * 60 * 1000), // 21 days from now
    description: "Beach vacation with family",
    location: "Hawaii",
    allDay: true,
  },
];

export function getMockCalendarEvents() {
  return MOCK_CALENDAR_EVENTS;
}
