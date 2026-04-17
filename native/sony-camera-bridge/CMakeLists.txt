cmake_minimum_required(VERSION 3.21)
project(sony_camera_bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(BRIDGE_TARGET sony-camera-bridge)
set(SONY_SDK_ROOT "${CMAKE_SOURCE_DIR}/../../vendor/RemoteCli")
set(SONY_CRSDK_DIR "${SONY_SDK_ROOT}/external/crsdk")

# ── Platform-specific output directory ────────────────────────────────────────
if(WIN32)
  set(BRIDGE_OUTPUT_DIR "${CMAKE_SOURCE_DIR}/../../vendor/sony-camera-bridge/win-x64")
elseif(APPLE)
  set(BRIDGE_OUTPUT_DIR "${CMAKE_SOURCE_DIR}/../../vendor/sony-camera-bridge/mac-arm64")
else()
  set(BRIDGE_OUTPUT_DIR "${CMAKE_SOURCE_DIR}/../../vendor/sony-camera-bridge/linux-x64")
endif()

add_executable(${BRIDGE_TARGET}
  src/main.cpp
)

target_include_directories(${BRIDGE_TARGET} PRIVATE
  "${SONY_SDK_ROOT}/app/CRSDK"
)

# ── Platform-specific compile definitions ─────────────────────────────────────
if(WIN32)
  target_compile_definitions(${BRIDGE_TARGET} PRIVATE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    UNICODE
    _UNICODE
  )
endif()

# ── Platform-specific link libraries ──────────────────────────────────────────
if(WIN32)
  find_library(SONY_CR_CORE_LIBRARY Cr_Core HINTS "${SONY_CRSDK_DIR}")
  target_link_libraries(${BRIDGE_TARGET} PRIVATE
    ws2_32
    ${SONY_CR_CORE_LIBRARY}
  )
elseif(APPLE)
  find_library(SONY_CR_CORE_LIBRARY Cr_Core HINTS "${SONY_CRSDK_DIR}")
  target_link_libraries(${BRIDGE_TARGET} PRIVATE
    ${SONY_CR_CORE_LIBRARY}
  )
  # Embed the rpath so the binary finds the dylib next to itself at runtime.
  set_target_properties(${BRIDGE_TARGET} PROPERTIES
    BUILD_RPATH "${BRIDGE_OUTPUT_DIR}"
    INSTALL_RPATH "@executable_path"
  )
endif()

set_target_properties(${BRIDGE_TARGET} PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${BRIDGE_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${BRIDGE_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${BRIDGE_OUTPUT_DIR}"
)

# ── Post-build: copy SDK runtime libs next to the binary ──────────────────────
if(WIN32)
  if(EXISTS "${SONY_CRSDK_DIR}")
    add_custom_command(TARGET ${BRIDGE_TARGET} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E make_directory "${BRIDGE_OUTPUT_DIR}"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/Cr_Core.dll"                   "${BRIDGE_OUTPUT_DIR}"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/monitor_protocol.dll"           "${BRIDGE_OUTPUT_DIR}"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/monitor_protocol_pf.dll"        "${BRIDGE_OUTPUT_DIR}"
      COMMAND ${CMAKE_COMMAND} -E make_directory "${BRIDGE_OUTPUT_DIR}/CrAdapter"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/Cr_PTP_IP.dll"       "${BRIDGE_OUTPUT_DIR}/CrAdapter"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/Cr_PTP_USB.dll"      "${BRIDGE_OUTPUT_DIR}/CrAdapter"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/libssh2.dll"         "${BRIDGE_OUTPUT_DIR}/CrAdapter"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/libusb-1.0.dll"      "${BRIDGE_OUTPUT_DIR}/CrAdapter"
    )
  endif()
elseif(APPLE)
  if(EXISTS "${SONY_CRSDK_DIR}")
    add_custom_command(TARGET ${BRIDGE_TARGET} POST_BUILD
      COMMAND ${CMAKE_COMMAND} -E make_directory "${BRIDGE_OUTPUT_DIR}"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/libCr_Core.dylib"                "${BRIDGE_OUTPUT_DIR}"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/libmonitor_protocol.dylib"       "${BRIDGE_OUTPUT_DIR}"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/libmonitor_protocol_pf.dylib"    "${BRIDGE_OUTPUT_DIR}"
      COMMAND ${CMAKE_COMMAND} -E make_directory "${BRIDGE_OUTPUT_DIR}/CrAdapter"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/libCr_PTP_IP.dylib"   "${BRIDGE_OUTPUT_DIR}/CrAdapter"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/libCr_PTP_USB.dylib"  "${BRIDGE_OUTPUT_DIR}/CrAdapter"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/libssh2.dylib"        "${BRIDGE_OUTPUT_DIR}/CrAdapter"
      COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/libusb-1.0.0.dylib"   "${BRIDGE_OUTPUT_DIR}/CrAdapter"
    )
  endif()
endif()
