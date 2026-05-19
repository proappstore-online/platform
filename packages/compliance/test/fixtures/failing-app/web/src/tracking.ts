// Real tracker import — must be in CODE, not a comment, so the
// no-tracking check fires after comment-stripping was added. APPNAME
// in the console.log triggers no-placeholders.
import * as amplitude from '@amplitude/analytics-browser';
export function init() {
  amplitude.init('API_KEY');
  console.log('APPNAME loaded');
}
