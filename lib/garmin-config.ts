// Garmin OAuth configuration
// These are placeholder values. Replace with real credentials when Garmin approves.

export const GARMIN_CONFIG = {
  CLIENT_ID: process.env.NEXT_PUBLIC_GARMIN_CLIENT_ID || "placeholder_client_id",
  CLIENT_SECRET: process.env.GARMIN_CLIENT_SECRET || "placeholder_secret",
  REDIRECT_URI:
    process.env.GARMIN_REDIRECT_URI ||
    "http://localhost:3000/api/garmin/callback",
  AUTH_URL: "https://connect.garmin.com/oauthserver/oauth/authorize",
  TOKEN_URL: "https://connect.garmin.com/oauthserver/oauth/token",
  API_URL: "https://apis.garmin.com",
};

// Mock workout data for development/testing
export const MOCK_WORKOUTS = [
  {
    id: "garmin_mock_1",
    name: "Morning Swim",
    startTime: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    duration: 2700, // 45 minutes in seconds
    sport: "SWIMMING",
    calories: 450,
    avgHeartRate: 145,
    maxHeartRate: 165,
    distance: 1500, // meters
    tss: 120,
    description: "Easy pace swim workout",
  },
  {
    id: "garmin_mock_2",
    name: "Bike Session",
    startTime: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
    duration: 5400, // 90 minutes
    sport: "CYCLING",
    calories: 850,
    avgHeartRate: 155,
    maxHeartRate: 180,
    distance: 35000, // meters
    tss: 200,
    description: "Steady state Zone 2 bike",
  },
  {
    id: "garmin_mock_3",
    name: "Trail Run",
    startTime: new Date(Date.now() - 12 * 60 * 60 * 1000), // 12 hours ago
    duration: 3600, // 60 minutes
    sport: "RUNNING",
    calories: 650,
    avgHeartRate: 165,
    maxHeartRate: 190,
    distance: 10000, // meters
    tss: 150,
    description: "Easy recovery run",
  },
];

// Generate mock workouts for testing
export function getMockWorkouts(daysBack: number = 30) {
  return MOCK_WORKOUTS.map((workout) => ({
    ...workout,
    startTime: new Date(
      Date.now() - Math.random() * daysBack * 24 * 60 * 60 * 1000
    ),
  }));
}
