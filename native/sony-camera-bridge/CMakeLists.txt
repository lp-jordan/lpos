cmake_minimum_required(VERSION 3.21)
project(sony_camera_bridge LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(BRIDGE_TARGET sony-camera-bridge)
set(BRIDGE_OUTPUT_DIR "${CMAKE_SOURCE_DIR}/../../vendor/sony-camera-bridge/win-x64")
set(SONY_SDK_ROOT "${CMAKE_SOURCE_DIR}/../../vendor/sony-camera-sdk/RemoteCli")
set(SONY_CRSDK_DIR "${SONY_SDK_ROOT}/external/crsdk")

add_executable(${BRIDGE_TARGET}
  src/main.cpp
)

target_include_directories(${BRIDGE_TARGET} PRIVATE
  "${SONY_SDK_ROOT}/app/CRSDK"
)

target_compile_definitions(${BRIDGE_TARGET} PRIVATE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  UNICODE
  _UNICODE
)

find_library(SONY_CR_CORE_LIBRARY Cr_Core HINTS "${SONY_CRSDK_DIR}")

target_link_libraries(${BRIDGE_TARGET} PRIVATE
  ws2_32
  ${SONY_CR_CORE_LIBRARY}
)

set_target_properties(${BRIDGE_TARGET} PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${BRIDGE_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${BRIDGE_OUTPUT_DIR}"
  RUNTIME_OUTPUT_DIRECTORY_DEBUG "${BRIDGE_OUTPUT_DIR}"
)

if(EXISTS "${SONY_CRSDK_DIR}")
  add_custom_command(TARGET ${BRIDGE_TARGET} POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E make_directory "${BRIDGE_OUTPUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/Cr_Core.dll" "${BRIDGE_OUTPUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/monitor_protocol.dll" "${BRIDGE_OUTPUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/monitor_protocol_pf.dll" "${BRIDGE_OUTPUT_DIR}"
    COMMAND ${CMAKE_COMMAND} -E make_directory "${BRIDGE_OUTPUT_DIR}/CrAdapter"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/Cr_PTP_IP.dll" "${BRIDGE_OUTPUT_DIR}/CrAdapter"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/Cr_PTP_USB.dll" "${BRIDGE_OUTPUT_DIR}/CrAdapter"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/libssh2.dll" "${BRIDGE_OUTPUT_DIR}/CrAdapter"
    COMMAND ${CMAKE_COMMAND} -E copy_if_different "${SONY_CRSDK_DIR}/CrAdapter/libusb-1.0.dll" "${BRIDGE_OUTPUT_DIR}/CrAdapter"
  )
endif()
