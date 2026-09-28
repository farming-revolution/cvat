# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

from django_sendfile import sendfile as _sendfile


def sendfile(
    request, filename, attachment=False, attachment_filename=None, mimetype=None, encoding=None
):
    """Keep nginx's internal redirect response valid for ASGI servers."""
    response = _sendfile(request, filename, attachment, attachment_filename, mimetype, encoding)
    if response.has_header("X-Accel-Redirect"):
        # django-sendfile2 sets the file's size even though this response has no
        # body. Uvicorn rejects that mismatch. nginx serves the actual file on
        # its internal redirect and computes the final Content-Length itself.
        response["Content-Length"] = "0"
    return response
