# Dashboard display performance, 0.5.2

Native Even Hub simulator 0.9.5, SDK 0.0.14, synthetic phone notifications. Checked opening and closing assistant dictation/review, notification overlay/reader/reply, sessions and transcripts. The completed navigation run recorded no native console errors. Screenshots show unchanged dashboard geometry, the covered notification background, and full-screen return selection.

Automated validation: 297 frontend tests, 40 deployment tests, 138 bridge tests, frontend/server type checks and production builds passed. Regression coverage verifies a single destination rebuild, lossless image cropping, five distinct notification-label updates, and interrupting/resuming serial image uploads.

The native simulator does not measure physical Bluetooth transfer or visible hardware latency. Returning from full-screen content still requires image uploads. The standard dashboard sends 134,803 pixel values rather than 165,888; this is an 18.7% reduction in raw pixels, not a measured latency improvement. The compact overlay retains its existing containers and changes only the two top image tiles.

A separate synthetic checkerboard probe tested a removable text mask with textColor 0. It remained visible through gaps and could not hide the background. No unsupported mask workaround is included.
