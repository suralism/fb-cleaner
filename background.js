// Background Service Worker for FB Activity Cleaner
// Configures the side panel behavior to open on action click

chrome.runtime.onInstalled.addListener(() => {
  // Set side panel to open when action button is clicked
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .then(() => {
        console.log('Side panel configured to open on action click.');
      })
      .catch((error) => {
        console.error('Error setting side panel behavior:', error);
      });
  }
});
