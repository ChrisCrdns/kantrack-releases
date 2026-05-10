#import <Foundation/Foundation.h>
#import <ServiceManagement/ServiceManagement.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

static char *kantrack_copy_error(NSError *error) {
  const char *message = "Could not update Launch at Login.";
  if (error != nil && error.localizedDescription != nil) {
    message = error.localizedDescription.UTF8String;
  }
  return strdup(message);
}

bool kantrack_login_item_is_enabled(void) {
  if (@available(macOS 13.0, *)) {
    return SMAppService.mainAppService.status == SMAppServiceStatusEnabled;
  }
  return false;
}

char *kantrack_login_item_set_enabled(bool enabled) {
  if (@available(macOS 13.0, *)) {
    NSError *error = nil;
    BOOL ok = enabled
      ? [SMAppService.mainAppService registerAndReturnError:&error]
      : [SMAppService.mainAppService unregisterAndReturnError:&error];
    return ok ? NULL : kantrack_copy_error(error);
  }

  return strdup("Launch at Login requires macOS 13 or later.");
}

void kantrack_login_item_free_error(char *message) {
  free(message);
}
