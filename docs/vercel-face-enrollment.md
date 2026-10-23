# Vercel face enrollment API

The face registration and matching clients use `POST /api/face/register` and
`POST /api/face/match` instead of the Firebase callables
`registerStudentFace` and `matchStudentFace`. Face-review listing and resolution
use `POST /api/face/review`. These routes verify the Firebase ID token and use
the Firebase Admin SDK; registration performs uniqueness checks, review queue
writes, enrollment updates, permission consumption, and audit logging.
Admin credentials are read only from server environment variables.

Review API operations are `{"operation":"list","rollNo":"..."}` and
`{"operation":"resolve","requestId":"...","action":"RECAPTURE_REQUIRED"}`.
The only resolution actions are `RECAPTURE_REQUIRED` and `REJECTED`; the API
does not allow staff to override face-uniqueness checks. Review responses
contain identity and decision metadata, never stored face descriptors.

This is a partial backend migration. Re-registration permission management,
hardware biometric enrollment/verification, attendance, device binding, and
other Firebase callable operations still use their existing Firebase
Functions endpoints and will remain unavailable until they are deployed or
migrated separately.

The current duplicate scan compares the captured 128-value face descriptor
with descriptors stored in Firestore. Its distance thresholds have not been
validated for a production biometric deployment; uncertain or unreadable
records are sent for staff review rather than automatically accepted. The
matching implementation also reads the enrolled and legacy records to compare
them, so its transaction cost and Firestore limits must be evaluated before
using it with a large student database.

## Required server environment

Configure these values in the Vercel project’s server-side environment settings:

- `FIREBASE_PROJECT_ID`: the Firebase project ID.
- `FIREBASE_SERVICE_ACCOUNT_JSON`: the full service-account JSON as a protected
  secret. Never use a `VITE_` prefix, commit it, or share it in chat.
- `APP_ALLOWED_ORIGINS`: comma-separated exact origins for any additional
  deployed web app or approved app origin not already listed below.

`VITE_API_BASE_URL` can be set to the HTTPS base URL of the deployed Vercel API.
If unset, the client uses `https://smartattend-ochre.vercel.app` on both web
and native builds. This is required when the frontend is hosted on Firebase
Hosting because Firebase Hosting does not serve these Vercel API routes. The
API explicitly allows the production Firebase Hosting origins
`https://smart-attendance-ok.web.app` and
`https://smart-attendance-ok.firebaseapp.com`, plus the Vite development origin
`http://localhost:5173` and Capacitor origins `https://localhost` and
`capacitor://localhost`; add any other production or preview origin to
`APP_ALLOWED_ORIGINS`.
Face registration, matching, and review calls do not fall back to Firebase
Functions: a missing API route is reported directly rather than surfacing an
unrelated callable error.

## Local testing

Use a test Firebase project and synthetic records only. Run the Vercel
development server with `npx vercel dev`, after configuring local server
environment variables in a private, ignored `.env.local` file. Do not use real
student biometrics for local testing.

Vercel Hobby is documented as personal/non-commercial use only. Confirm plan
eligibility for an institutional pilot before using it with college data.
Exceeding free quotas can pause service. No deployment or billing change has
been performed by this code change.
